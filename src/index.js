import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Agent } from "undici";
import WebSocket from "ws";
import {
  DEFAULT_WORKFLOW_PRESET_ID,
  GENERATION_FPS,
  RESOLUTION_PRESETS,
  configureWorkflow,
  createWorkflowRegistry,
  normalizeKeyframes
} from "./workflow-presets.js";

const PLUGIN_ID = "dsh-comfy-video-studio";
const API_PREFIX = "/comfy-video/api";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtInWorkflowManifest = join(root, "assets", "workflows", "minimax-h3-default.preset.json");
const DEFAULT_VIDEO_RULES = Object.freeze({
  smooth_rotation: "镜头转动平滑连续，非明确要求时停顿不超过 500ms",
  portrait_9_16: "默认采用 9:16 手机竖屏画面",
  handheld_motion: "运镜带轻微、自然的手机手持抖动",
  fixed_body_direction: "镜头转动时人物头部和身体方向不跟随镜头",
  fixed_gaze: "人物视线保持原方向，不追随镜头",
  natural_blink: "人物平均每 3-8 秒自然眨眼一次；短于 3 秒不强制眨眼"
});
const DEFAULT_VIDEO_RULE_IDS = Object.freeze(Object.keys(DEFAULT_VIDEO_RULES));
const DEFAULT_CONNECTION_PRESET_ID = "default";

export const inject = ["webServer", "llm", "agents"];

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store"
  });
  res.end(body);
}

function publicError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error(`request body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit = 1024 * 1024) {
  const body = await readBody(req, limit);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("ComfyUI baseUrl must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("ComfyUI baseUrl 不能包含用户名或密码，请在反向代理中配置认证");
  }
  return parsed.toString().replace(/\/$/, "");
}

function createConnectionCatalog(rawConfig, fallbackBaseUrl) {
  const configured = rawConfig.connectionPresets;
  const source = configured === undefined ? [{
    id: DEFAULT_CONNECTION_PRESET_ID,
    name: "默认 ComfyUI",
    baseUrl: fallbackBaseUrl
  }] : configured;
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error("connectionPresets 必须是非空数组");
  }
  const presets = new Map();
  for (const item of source) {
    const id = String(item?.id ?? "").trim();
    const name = String(item?.name ?? "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
      throw new Error(`ComfyUI 连接预设 ID 无效：${id || "<empty>"}`);
    }
    if (!name || name.length > 120) throw new Error(`ComfyUI 连接预设名称无效：${id}`);
    if (presets.has(id)) throw new Error(`ComfyUI 连接预设 ID 重复：${id}`);
    const baseUrl = normalizeBaseUrl(item?.baseUrl);
    const allowSelfSigned = item?.allowSelfSigned === true;
    if (allowSelfSigned && !baseUrl.startsWith("https:")) {
      throw new Error(`allowSelfSigned 仅适用于 HTTPS 连接：${id}`);
    }
    presets.set(id, {
      id,
      name,
      baseUrl,
      allowSelfSigned,
      dispatcher: allowSelfSigned ? new Agent({ connect: { rejectUnauthorized: false } }) : null
    });
  }
  const defaultId = String(rawConfig.defaultConnectionPresetId ?? source[0].id).trim();
  if (!presets.has(defaultId)) throw new Error(`默认 ComfyUI 连接预设不存在：${defaultId}`);
  return {
    defaultId,
    get(id) {
      const requested = String(id || defaultId).trim();
      const preset = presets.get(requested);
      if (!preset) throw new Error(`未知的 ComfyUI 连接预设：${requested}`);
      return preset;
    },
    list() {
      return {
        defaultId,
        presets: [...presets.values()].map(({ id, name, baseUrl, allowSelfSigned }) => ({ id, name, baseUrl, allowSelfSigned }))
      };
    },
    async close() {
      await Promise.all([...presets.values()].map((item) => item.dispatcher?.close?.()).filter(Boolean));
    }
  };
}

function websocketUrl(baseUrl, clientId) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  url.search = new URLSearchParams({ clientId }).toString();
  return url.toString();
}

function finiteNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function integer(value, fallback, min, max) {
  return Math.round(finiteNumber(value, fallback, min, max));
}

function outputDirectory(values) {
  const outputDirectory = String(values.outputDirectory ?? "").trim();
  if (!isAbsolute(outputDirectory)) throw new Error("输出目录必须是远程主机上的绝对路径");
  return outputDirectory;
}

function contentType(filename) {
  switch (extname(filename).toLowerCase()) {
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".mov": return "video/quicktime";
    case ".mkv": return "video/x-matroska";
    case ".gif": return "image/gif";
    default: return "application/octet-stream";
  }
}

function findMedia(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) findMedia(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  if (
    typeof value.filename === "string" &&
    /\.(mp4|webm|mov|mkv|gif)$/i.test(value.filename)
  ) {
    result.push({
      filename: value.filename,
      subfolder: typeof value.subfolder === "string" ? value.subfolder : "",
      type: typeof value.type === "string" ? value.type : "output"
    });
  }
  for (const item of Object.values(value)) findMedia(item, result);
  return result;
}

async function availablePath(directory, filename, taskId) {
  const safeName = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  const parsed = extname(safeName);
  const stem = safeName.slice(0, safeName.length - parsed.length);
  let candidate = join(directory, safeName);
  try {
    await access(candidate);
    candidate = join(directory, `${stem}-${taskId.slice(0, 8)}${parsed}`);
  } catch {
    return candidate;
  }
  return candidate;
}

function taskView(task) {
  return {
    id: task.id,
    promptId: task.promptId,
    mode: task.mode,
    prompt: task.prompt,
    connectionPresetId: task.connection.id,
    connectionName: task.connection.name,
    connectionBaseUrl: task.connection.baseUrl,
    connectionAllowSelfSigned: task.connection.allowSelfSigned,
    workflowPresetId: task.workflowPresetId,
    resolutionPreset: task.resolutionPreset,
    keyframes: task.keyframes,
    frameCount: task.frameCount,
    status: task.status,
    stage: task.stage,
    currentNode: task.currentNode,
    progress: task.progress,
    queueRemaining: task.queueRemaining,
    outputDirectory: task.outputDirectory,
    outputPath: task.outputPath,
    videoUrl: task.outputPath ? `${API_PREFIX}/video/${encodeURIComponent(task.id)}` : null,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function touch(task, patch) {
  Object.assign(task, patch, { updatedAt: Date.now() });
  task.onChange?.();
}

function finishError(finish) {
  if (!finish) return new Error("模型没有返回终止状态");
  if (finish.kind === "stop") return null;
  if (finish.kind === "max-tokens") return new Error("提示词优化输出超过模型上限");
  if (finish.kind === "aborted") return new Error("提示词优化已取消");
  if (finish.kind === "error") return new Error(finish.failure?.message ?? "模型调用失败");
  return new Error(`提示词优化异常结束：${finish.kind}`);
}

function userMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: "user",
    content: Object.freeze([Object.freeze({ type: "text", text })]),
    source: Object.freeze({ kind: "plugin", plugin: PLUGIN_ID })
  });
}

function parseOptimizationDecision(raw) {
  const normalized = String(raw ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型未按约定返回优化决策，请重试");

  let value;
  try {
    value = JSON.parse(normalized.slice(start, end + 1));
  } catch {
    throw new Error("模型返回的优化决策不是有效 JSON，请重试");
  }

  if (value?.decision === "clarify") {
    const questions = Array.isArray(value.questions)
      ? value.questions.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 3)
      : [];
    if (questions.length === 0) throw new Error("模型认为需要澄清，但没有给出具体问题");
    return {
      decision: "clarify",
      questions,
      reason: String(value.reason ?? "关键信息会影响视频结果").trim()
    };
  }

  if (value?.decision === "ready") {
    const prompt = String(value.prompt ?? "").trim();
    if (!prompt) throw new Error("模型没有返回优化后的提示词");
    const appliedRules = Array.isArray(value.appliedRules)
      ? [...new Set(value.appliedRules.map(String).filter((id) => DEFAULT_VIDEO_RULE_IDS.includes(id)))]
      : [];
    const overriddenRules = value.overriddenRules && typeof value.overriddenRules === "object" && !Array.isArray(value.overriddenRules)
      ? Object.fromEntries(Object.entries(value.overriddenRules)
        .filter(([id, reason]) => DEFAULT_VIDEO_RULE_IDS.includes(id) && String(reason ?? "").trim())
        .map(([id, reason]) => [id, String(reason).trim()]))
      : {};
    const duplicatedRules = appliedRules.filter((id) => Object.hasOwn(overriddenRules, id));
    if (duplicatedRules.length > 0) throw new Error(`默认规则不能同时标记为应用和覆盖：${duplicatedRules.join(", ")}`);
    const covered = new Set([...appliedRules, ...Object.keys(overriddenRules)]);
    const missingRules = DEFAULT_VIDEO_RULE_IDS.filter((id) => !covered.has(id));
    if (missingRules.length > 0) {
      const error = new Error(`模型未说明默认规则：${missingRules.join(", ")}`);
      error.code = "DEFAULT_RULES_INCOMPLETE";
      error.missingRules = missingRules;
      throw error;
    }
    return {
      decision: "ready",
      prompt,
      summary: String(value.summary ?? "已补全画面、动作、镜头和节奏").trim(),
      appliedRules,
      overriddenRules
    };
  }

  throw new Error("模型返回了未知的优化决策，请重试");
}

export function apply(ctx, rawConfig = {}) {
  const dshHome = resolve(process.env.DSH_HOME || join(homedir(), ".dsh"));
  const config = {
    baseUrl: rawConfig.baseUrl ?? "http://127.0.0.1:8188",
    maxUploadMb: rawConfig.maxUploadMb ?? 40,
    requestTimeoutMs: rawConfig.requestTimeoutMs ?? 30000,
    historyLimit: integer(rawConfig.historyLimit, 200, 10, 2000),
    historyFile: resolve(rawConfig.historyFile || join(dshHome, "storages", PLUGIN_ID, "history.json")),
    workflowDirectory: resolve(rawConfig.workflowDirectory || join(dshHome, "storages", PLUGIN_ID, "workflows"))
  };
  const connectionCatalog = createConnectionCatalog(rawConfig, config.baseUrl);
  const workflowRegistry = createWorkflowRegistry({
    builtInManifest: builtInWorkflowManifest,
    customDirectory: config.workflowDirectory,
    logger: ctx.logger
  });
  let workflowReady = workflowRegistry.refresh();
  const promptTemplates = new Map();
  const tasks = new Map();
  const sockets = new Set();
  let disposed = false;
  let historyTimer = null;
  let historyWrite = Promise.resolve();

  function taskRecord(task) {
    return {
      ...taskView(task),
      clientId: task.clientId
    };
  }

  function persistHistory() {
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = null;
    const records = [...tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, config.historyLimit)
      .map(taskRecord);
    historyWrite = historyWrite.catch(() => {}).then(async () => {
      await mkdir(dirname(config.historyFile), { recursive: true });
      const temporary = `${config.historyFile}.partial-${process.pid}`;
      const savedTemplates = [...promptTemplates.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      await writeFile(temporary, `${JSON.stringify({ version: 2, tasks: records, templates: savedTemplates }, null, 2)}\n`, "utf8");
      await rename(temporary, config.historyFile);
    });
    return historyWrite;
  }

  function scheduleHistory() {
    if (disposed || historyTimer) return;
    historyTimer = setTimeout(() => {
      historyTimer = null;
      void persistHistory().catch((error) => ctx.logger?.warn?.(`[${PLUGIN_ID}] history write failed: ${publicError(error)}`));
    }, 250);
  }

  function hydrateTask(record) {
    const status = ["connecting", "queued", "running", "finalizing", "writing", "completed", "failed", "cancelled"].includes(record?.status)
      ? record.status
      : "failed";
    const connectionPresetId = String(record?.connectionPresetId || connectionCatalog.defaultId);
    let configuredConnection = null;
    try {
      configuredConnection = connectionCatalog.get(connectionPresetId);
    } catch {
      if (!record?.connectionBaseUrl) configuredConnection = connectionCatalog.get();
    }
    const recordedBaseUrl = record?.connectionBaseUrl ? normalizeBaseUrl(record.connectionBaseUrl) : configuredConnection.baseUrl;
    const recordedAllowSelfSigned = record?.connectionAllowSelfSigned === undefined
      ? configuredConnection?.allowSelfSigned === true
      : record.connectionAllowSelfSigned === true;
    const connection = configuredConnection && recordedBaseUrl === configuredConnection.baseUrl && recordedAllowSelfSigned === configuredConnection.allowSelfSigned
      ? configuredConnection
      : {
          id: connectionPresetId,
          name: String(record?.connectionName || configuredConnection?.name || connectionPresetId),
          baseUrl: recordedBaseUrl,
          allowSelfSigned: recordedAllowSelfSigned,
          dispatcher: recordedAllowSelfSigned ? new Agent({ connect: { rejectUnauthorized: false } }) : null,
          ephemeral: true
        };
    return {
      id: String(record?.id || randomUUID()),
      promptId: record?.promptId ? String(record.promptId) : null,
      clientId: String(record?.clientId || randomUUID()),
      mode: ["t2v", "i2v", "keyframe"].includes(record?.mode) ? record.mode : "t2v",
      prompt: String(record?.prompt || ""),
      connection,
      workflowPresetId: String(record?.workflowPresetId || DEFAULT_WORKFLOW_PRESET_ID),
      resolutionPreset: RESOLUTION_PRESETS[record?.resolutionPreset] ? record.resolutionPreset : "balanced",
      keyframes: Array.isArray(record?.keyframes) ? record.keyframes : [],
      frameCount: Number.isInteger(record?.frameCount) ? record.frameCount : null,
      outputDirectory: String(record?.outputDirectory || ""),
      outputPath: record?.outputPath ? String(record.outputPath) : null,
      status,
      stage: String(record?.stage || "历史任务"),
      currentNode: record?.currentNode ?? null,
      progress: record?.progress && typeof record.progress === "object" ? record.progress : { value: 0, max: 0, percent: null },
      queueRemaining: record?.queueRemaining ?? null,
      error: record?.error ? String(record.error) : null,
      createdAt: finiteNumber(record?.createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
      updatedAt: finiteNumber(record?.updatedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
      socket: null,
      poller: null,
      finalizing: false,
      onChange: scheduleHistory
    };
  }

  async function loadHistory() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(config.historyFile, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      ctx.logger?.warn?.(`[${PLUGIN_ID}] history load failed: ${publicError(error)}`);
      return;
    }
    const records = Array.isArray(parsed?.tasks) ? parsed.tasks.slice(0, config.historyLimit) : [];
    for (const record of records) {
      const task = hydrateTask(record);
      tasks.set(task.id, task);
    }
    for (const record of Array.isArray(parsed?.templates) ? parsed.templates : []) {
      const id = String(record?.id || "").trim();
      const name = String(record?.name || "").trim();
      const prompt = String(record?.prompt || "").trim();
      const mode = ["t2v", "i2v", "keyframe"].includes(record?.mode) ? record.mode : null;
      if (!id || !name || !prompt || !mode) continue;
      promptTemplates.set(id, {
        id,
        name: name.slice(0, 120),
        prompt: prompt.slice(0, 20000),
        mode,
        createdAt: finiteNumber(record?.createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
        updatedAt: finiteNumber(record?.updatedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER)
      });
    }
    for (const task of tasks.values()) {
      if (["completed", "failed", "cancelled"].includes(task.status)) continue;
      if (!task.promptId) {
        touch(task, { status: "failed", stage: "Harness 重启后无法恢复尚未提交的任务", error: "任务在取得 ComfyUI prompt_id 前中断" });
        continue;
      }
      touch(task, { stage: "Harness 已重启，正在恢复 ComfyUI 任务监控", error: null });
      void connectSocket(task).catch((error) => {
        touch(task, { stage: `恢复实时通道失败，继续轮询：${publicError(error)}`, error: null });
      });
      startHistoryFallback(task);
    }
  }

  const historyReady = loadHistory();

  async function savePromptTemplate(payload) {
    const name = String(payload?.name ?? "").trim();
    const prompt = String(payload?.prompt ?? "").trim();
    const mode = ["t2v", "i2v", "keyframe"].includes(payload?.mode) ? payload.mode : null;
    if (!name) throw new Error("模板名称不能为空");
    if (!prompt) throw new Error("模板提示词不能为空");
    if (!mode) throw new Error("模板模式无效");
    if (name.length > 120) throw new Error("模板名称不能超过 120 个字符");
    if (prompt.length > 20000) throw new Error("模板提示词不能超过 20000 个字符");
    const requestedId = String(payload?.id ?? "").trim();
    const existing = requestedId ? promptTemplates.get(requestedId) : null;
    if (requestedId && !existing) throw new Error("要更新的模板不存在");
    const now = Date.now();
    const record = {
      id: existing?.id || randomUUID(),
      name,
      prompt,
      mode,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    promptTemplates.set(record.id, record);
    await persistHistory();
    return record;
  }

  async function comfy(connection, pathname, init = {}, timeoutMs = config.requestTimeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${connection.baseUrl}${pathname}`, {
        ...init,
        signal: controller.signal,
        ...(connection.dispatcher ? { dispatcher: connection.dispatcher } : {})
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1000);
        throw new Error(`ComfyUI ${response.status}: ${detail || response.statusText}`);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async function comfyJson(connection, pathname, init) {
    const response = await comfy(connection, pathname, init);
    return response.json();
  }

  async function copyOutput(task, descriptor) {
    touch(task, { status: "writing", stage: "正在写入指定目录" });
    await mkdir(task.outputDirectory, { recursive: true });
    const filename = descriptor.filename.split(/[\\/]/).pop() || `video-${task.id}.mp4`;
    const destination = await availablePath(task.outputDirectory, filename, task.id);
    const temporary = `${destination}.partial-${task.id}`;
    const params = new URLSearchParams({
      filename: descriptor.filename,
      subfolder: descriptor.subfolder,
      type: descriptor.type
    });
    const response = await comfy(task.connection, `/view?${params}`, {}, 24 * 60 * 60 * 1000);
    if (!response.body) throw new Error("ComfyUI 视频响应没有内容");
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    touch(task, {
      status: "completed",
      stage: "制作完成",
      progress: { value: 1, max: 1, percent: 100 },
      outputPath: destination
    });
  }

  async function finalize(task) {
    if (task.finalizing || task.status === "completed" || task.status === "failed") return;
    task.finalizing = true;
    try {
      touch(task, { status: "finalizing", stage: "正在读取生成结果" });
      const history = await comfyJson(task.connection, `/history/${encodeURIComponent(task.promptId)}`);
      const record = history?.[task.promptId] ?? history;
      const outputs = findMedia(record?.outputs ?? record);
      if (outputs.length === 0) throw new Error("工作流已结束，但历史记录中没有找到视频输出");
      await copyOutput(task, outputs[0]);
    } catch (error) {
      touch(task, { status: "failed", stage: "落盘失败", error: publicError(error) });
    } finally {
      task.finalizing = false;
      if (task.poller) clearInterval(task.poller);
      task.poller = null;
      task.socket?.close();
    }
  }

  function watchSocket(task, socket) {
    socket.on("message", (raw) => {
      if (typeof raw !== "string" && !Buffer.isBuffer(raw)) return;
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const data = event.data ?? {};
      if (data.prompt_id && task.promptId && data.prompt_id !== task.promptId) return;
      if (event.type === "status") {
        const remaining = data.status?.exec_info?.queue_remaining;
        if (Number.isFinite(remaining)) touch(task, { queueRemaining: remaining });
      } else if (event.type === "execution_start") {
        touch(task, { status: "running", stage: "ComfyUI 开始执行" });
      } else if (event.type === "executing") {
        if (data.node === null && task.promptId) {
          void finalize(task);
        } else {
          touch(task, { status: "running", stage: "正在执行节点", currentNode: data.node ?? null });
        }
      } else if (event.type === "progress") {
        const value = Number(data.value ?? 0);
        const max = Number(data.max ?? 0);
        touch(task, {
          status: "running",
          stage: "正在采样",
          progress: {
            value,
            max,
            percent: max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : null
          }
        });
      } else if (event.type === "execution_success") {
        void finalize(task);
      } else if (event.type === "execution_error" || event.type === "execution_interrupted") {
        touch(task, {
          status: event.type === "execution_interrupted" ? "cancelled" : "failed",
          stage: event.type === "execution_interrupted" ? "已取消" : "执行失败",
          error: data.exception_message ?? data.error ?? null
        });
      }
    });
    socket.on("error", (error) => {
      if (task.status === "connecting") touch(task, { stage: "WebSocket 不可用，已切换轮询", error: null });
      ctx.logger?.warn?.(`[${PLUGIN_ID}] ComfyUI WebSocket: ${publicError(error)}`);
    });
    socket.on("close", () => sockets.delete(socket));
  }

  async function connectSocket(task) {
    const socket = new WebSocket(websocketUrl(task.connection.baseUrl, task.clientId), {
      rejectUnauthorized: !task.connection.allowSelfSigned
    });
    task.socket = socket;
    sockets.add(socket);
    watchSocket(task, socket);
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error("WebSocket 连接超时")), 5000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolveOpen();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        rejectOpen(error);
      });
    });
  }

  function startHistoryFallback(task) {
    task.poller = setInterval(async () => {
      if (!task.promptId || ["completed", "failed", "cancelled"].includes(task.status)) return;
      try {
        const history = await comfyJson(task.connection, `/history/${encodeURIComponent(task.promptId)}`);
        if (history?.[task.promptId] || history?.outputs) await finalize(task);
      } catch {
        // Empty history and transient connection failures are expected while a job runs.
      }
    }, 2000);
  }

  async function createTask(payload) {
    const mode = ["t2v", "i2v", "keyframe"].includes(payload.mode) ? payload.mode : "t2v";
    const id = randomUUID();
    await workflowReady;
    const values = payload.values ?? {};
    const connection = connectionCatalog.get(payload.connectionPresetId || values.connectionPresetId);
    const normalizedKeyframes = mode === "keyframe" ? normalizeKeyframes(values) : [];
    const workflowPresetId = String(payload.workflowPresetId || values.workflowPresetId || DEFAULT_WORKFLOW_PRESET_ID).trim();
    const { entry } = workflowRegistry.get(workflowPresetId, mode, mode === "keyframe" ? normalizedKeyframes.length : null);
    const configured = configureWorkflow({
      entry,
      mode,
      values: mode === "keyframe" ? { ...values, keyframes: normalizedKeyframes } : values,
      taskId: id
    });
    const destination = outputDirectory(values);
    const task = {
      id,
      promptId: null,
      clientId: randomUUID(),
      mode,
      prompt: configured.prompt,
      connection,
      workflowPresetId,
      resolutionPreset: configured.resolution.id,
      keyframes: configured.keyframes,
      frameCount: configured.frameCount,
      outputDirectory: resolve(destination),
      outputPath: null,
      status: "connecting",
      stage: "正在连接 ComfyUI",
      currentNode: null,
      progress: { value: 0, max: 0, percent: null },
      queueRemaining: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      socket: null,
      poller: null,
      finalizing: false,
      onChange: scheduleHistory
    };
    tasks.set(id, task);
    scheduleHistory();
    try {
      await connectSocket(task).catch((error) => {
        touch(task, { stage: `实时通道不可用，使用轮询：${publicError(error)}` });
      });
      touch(task, { status: "queued", stage: "正在提交工作流" });
      const answer = await comfyJson(task.connection, "/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: configured.workflow, client_id: task.clientId })
      });
      if (!answer.prompt_id) throw new Error("ComfyUI 未返回 prompt_id");
      touch(task, { promptId: answer.prompt_id, stage: "已进入 ComfyUI 队列" });
      startHistoryFallback(task);
      return task;
    } catch (error) {
      touch(task, { status: "failed", stage: "提交失败", error: publicError(error) });
      task.socket?.close();
      throw error;
    }
  }

  async function optimize(payload) {
    await workflowReady;
    const sessionId = String(payload.sessionId ?? "");
    const provider = String(payload.provider ?? "");
    const model = String(payload.model ?? "");
    const prompt = String(payload.prompt ?? "").trim();
    const isImageToVideo = payload.mode === "i2v";
    const isKeyframe = payload.mode === "keyframe";
    const mode = isKeyframe ? "关键帧生成视频" : isImageToVideo ? "图生视频" : "文生视频";
    const duration = finiteNumber(payload.duration, isImageToVideo || isKeyframe ? 10 : 5, 1, 60);
    const resolution = RESOLUTION_PRESETS[payload.resolutionPreset] || RESOLUTION_PRESETS.balanced;
    const aspectRatio = `${resolution.width}×${resolution.height}，9:16 手机竖屏`;
    const hasImage = Boolean(String(payload.image ?? "").trim());
    const keyframes = isKeyframe ? normalizeKeyframes({ keyframes: payload.keyframes, duration }) : [];
    const workflowPresetId = String(payload.workflowPresetId || DEFAULT_WORKFLOW_PRESET_ID).trim();
    workflowRegistry.get(workflowPresetId, payload.mode, isKeyframe ? keyframes.length : null);
    if (!sessionId || !ctx.agents.get(sessionId)) throw new Error("当前会话不可用，请先打开一个 Harness 会话");
    if (!provider || !model) throw new Error("当前会话尚未选择模型");
    if (!prompt) throw new Error("请输入需要优化的提示词");
    if (isImageToVideo && !hasImage) throw new Error("图生视频必须先上传参考图，再进行 AI 优化");
    const timeline = keyframes.map((item) => `@${item.ref}=${item.timeSeconds.toFixed(3)}秒（第${item.frameIndex}帧）`).join(" → ");
    const ruleLines = DEFAULT_VIDEO_RULE_IDS.map((id) => `${id}: ${DEFAULT_VIDEO_RULES[id]}`);

    const system = [
      "你是 MiniMax H3 视频提示词导演和需求完整性审查器。",
      `任务类型：${mode}；目标时长：${duration} 秒；画幅：${aspectRatio}。`,
      "先判断原始描述是否存在会显著改变成片结果、且无法用保守默认值解决的歧义。",
      "只有缺少主体、核心事件/动作、关键时序，或存在互相冲突的意图时才澄清；不要为了偏好细节过度提问。",
      "需要澄清时最多提出 3 个能改变决策的问题，当前步骤必须停止，不得先猜测并生成提示词。",
      "信息充分时，输出可直接交给 MiniMax H3 的简洁中文提示词；保留用户明确的人物、数量、身份、动作、场景和事件。",
      "提示词以清晰为目标，不为长度堆砌形容词；除非原始需求本身复杂，最终提示词控制在 1800 个中文字符以内。",
      "文生视频按主体与外观、环境、主体动作、环境运动、镜头景别与运动、光线风格、分段时序组织。",
      "图生视频把参考图作为第 0 秒与静态视觉事实；不得虚构身份、服装、颜色或隐藏侧几何。",
      isKeyframe ? `关键帧时间线：${timeline}。每个 @K 引用只代表该时刻图片中的静态可见事实；只描述相邻引用之间的连续过渡，不得用文字重写图片事实。` : "",
      "单镜头优先只安排一个主要运动载体；动作按建立、执行、停稳分配到目标时长。",
      "下列六项是默认拍摄规则。用户没有明确提出相反要求时必须整合进提示词；如用户明确冲突，保留用户要求，并在 overriddenRules 中用一句话说明原因：",
      ...ruleLines,
      "ready 输出必须让六个规则 ID 全部且仅出现于 appliedRules 或 overriddenRules；不得遗漏，也不得同时出现在两处。",
      "只返回一行合法 JSON，不要 Markdown。两种唯一格式：",
      '{"decision":"clarify","reason":"为什么必须确认","questions":["问题1","问题2"]}',
      '{"decision":"ready","summary":"做了哪些关键补全","prompt":"完整优化提示词","appliedRules":["smooth_rotation","portrait_9_16","handheld_motion","fixed_body_direction","fixed_gaze","natural_blink"],"overriddenRules":{}}'
    ].filter(Boolean).join("\n");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(config.requestTimeoutMs, 120000));
    try {
      const run = async (retryNote = "") => {
        const input = [prompt, isKeyframe ? `关键帧引用时间线：${timeline}` : "", retryNote].filter(Boolean).join("\n\n");
        const options = Object.freeze({
          provider,
          model,
          messages: Object.freeze([userMessage(input)]),
          system,
          maxTokens: 2200,
          sessionId,
          purpose: "comfy-video-prompt-optimization",
          signal: controller.signal
        });
        const fragments = [];
        let fallbackText = "";
        let finish = null;
        for await (const chunk of ctx.llm.stream(options)) {
          if (chunk.type === "text-delta") fragments.push(chunk.text);
          if (chunk.type === "block-end" && chunk.block?.type === "text") fallbackText += chunk.block.text;
          if (chunk.type === "finish") finish = chunk.reason;
        }
        const failed = finishError(finish);
        if (failed) throw failed;
        const text = (fragments.length > 0 ? fragments.join("") : fallbackText).trim();
        if (!text) throw new Error("模型没有返回优化决策");
        return parseOptimizationDecision(text);
      };
      let decision;
      try {
        decision = await run();
      } catch (error) {
        if (error?.code !== "DEFAULT_RULES_INCOMPLETE") throw error;
        decision = await run(`上次输出遗漏规则 ID：${error.missingRules.join(", ")}。请重新返回完整 JSON。`);
      }
      return { ...decision, provider, model, workflowPresetId, timeline: keyframes };
    } finally {
      clearTimeout(timer);
    }
  }

  async function cancelTask(task) {
    if (["completed", "failed", "cancelled"].includes(task.status)) return;
    if (task.status === "queued" && task.promptId) {
      await comfy(task.connection, "/queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delete: [task.promptId] })
      });
    } else {
      await comfy(task.connection, "/interrupt", { method: "POST" });
    }
    touch(task, { status: "cancelled", stage: "已取消" });
    if (task.poller) clearInterval(task.poller);
    task.socket?.close();
  }

  async function upload(req, connection) {
    const maxBytes = Math.round(config.maxUploadMb * 1024 * 1024);
    const bytes = await readBody(req, maxBytes);
    if (bytes.length === 0) throw new Error("上传文件为空");
    const rawName = req.headers["x-file-name"];
    const filename = decodeURIComponent(Array.isArray(rawName) ? rawName[0] : rawName || "input.png")
      .split(/[\\/]/)
      .pop();
    const mime = String(req.headers["content-type"] ?? "application/octet-stream");
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: mime }), filename);
    form.append("type", "input");
    form.append("overwrite", "false");
    const response = await comfy(connection, "/upload/image", { method: "POST", body: form });
    return response.json();
  }

  async function serveVideo(req, res, task) {
    if (!task?.outputPath) return json(res, 404, { error: "视频尚未生成" });
    let info;
    try {
      info = await stat(task.outputPath);
    } catch {
      return json(res, 404, { error: "输出文件不存在" });
    }
    const type = contentType(task.outputPath);
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, {
        "content-type": type,
        "content-length": info.size,
        "accept-ranges": "bytes",
        "cache-control": "private, no-cache"
      });
      if (req.method === "HEAD") return res.end();
      return createReadStream(task.outputPath).pipe(res);
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { "content-range": `bytes */${info.size}` });
      return res.end();
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      res.writeHead(416, { "content-range": `bytes */${info.size}` });
      return res.end();
    }
    res.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${info.size}`,
      "accept-ranges": "bytes",
      "cache-control": "private, no-cache"
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(task.outputPath, { start, end }).pipe(res);
  }

  async function handler(req, res) {
    const url = new URL(req.url ?? "/", "http://dsh.local");
    const path = url.pathname.slice(API_PREFIX.length) || "/";
    try {
      await historyReady;
      await workflowReady;
      if (req.method === "GET" && path === "/health") {
        const connection = connectionCatalog.get(url.searchParams.get("connectionPresetId"));
        const [stats, objectInfo] = await Promise.all([
          comfyJson(connection, "/system_stats"),
          comfyJson(connection, "/object_info")
        ]);
        const required = [
          "SaveVideo", "LoadImage", "VAELoader", "VAEDecodeAudio",
          "KSamplerSelect", "BasicScheduler", "SamplerCustomAdvanced", "BasicGuider",
          "UNETLoader", "CLIPLoader", "RandomNoise", "CreateVideo",
          "MiniMaxH3ImageToVideo", "MiniMaxH3AddImageGuideBackport", "Video Slice", "ComfyMathExpression", "PrimitiveFloat"
        ];
        const missingNodes = required.filter((name) => !objectInfo?.[name]);
        return json(res, 200, {
          ok: missingNodes.length === 0,
          connection: {
            id: connection.id,
            name: connection.name,
            baseUrl: connection.baseUrl,
            allowSelfSigned: connection.allowSelfSigned
          },
          missingNodes,
          stats,
          historyFile: config.historyFile,
          workflowDirectory: config.workflowDirectory,
          workflows: workflowRegistry.list()
        });
      }
      if (req.method === "GET" && path === "/connections") {
        return json(res, 200, connectionCatalog.list());
      }
      if (req.method === "POST" && path === "/upload") {
        const connection = connectionCatalog.get(url.searchParams.get("connectionPresetId"));
        return json(res, 200, await upload(req, connection));
      }
      if (req.method === "POST" && path === "/optimize") {
        return json(res, 200, await optimize(await readJson(req)));
      }
      if (req.method === "POST" && path === "/generate") {
        const task = await createTask(await readJson(req));
        return json(res, 202, taskView(task));
      }
      if (req.method === "GET" && path === "/workflows") {
        return json(res, 200, workflowRegistry.list());
      }
      if (req.method === "POST" && path === "/workflows/refresh") {
        workflowReady = workflowRegistry.refresh();
        return json(res, 200, await workflowReady);
      }
      if (req.method === "GET" && path === "/templates") {
        return json(res, 200, [...promptTemplates.values()].sort((a, b) => b.updatedAt - a.updatedAt));
      }
      if (req.method === "POST" && path === "/templates") {
        return json(res, 200, await savePromptTemplate(await readJson(req)));
      }
      const templateMatch = /^\/templates\/([^/]+)$/.exec(path);
      if (req.method === "DELETE" && templateMatch) {
        const removed = promptTemplates.delete(decodeURIComponent(templateMatch[1]));
        if (!removed) return json(res, 404, { error: "模板不存在" });
        await persistHistory();
        return json(res, 200, { removed: 1 });
      }
      if (req.method === "GET" && path === "/tasks") {
        return json(res, 200, [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).map(taskView));
      }
      if (req.method === "DELETE" && path === "/tasks") {
        let removed = 0;
        for (const [id, task] of tasks) {
          if (!["completed", "failed", "cancelled"].includes(task.status)) continue;
          tasks.delete(id);
          removed += 1;
        }
        await persistHistory();
        return json(res, 200, { removed });
      }
      const taskMatch = /^\/tasks\/([^/]+)$/.exec(path);
      if (req.method === "GET" && taskMatch) {
        const task = tasks.get(decodeURIComponent(taskMatch[1]));
        return task ? json(res, 200, taskView(task)) : json(res, 404, { error: "任务不存在" });
      }
      const cancelMatch = /^\/tasks\/([^/]+)\/cancel$/.exec(path);
      if (req.method === "POST" && cancelMatch) {
        const task = tasks.get(decodeURIComponent(cancelMatch[1]));
        if (!task) return json(res, 404, { error: "任务不存在" });
        await cancelTask(task);
        return json(res, 200, taskView(task));
      }
      const videoMatch = /^\/video\/([^/]+)$/.exec(path);
      if ((req.method === "GET" || req.method === "HEAD") && videoMatch) {
        return serveVideo(req, res, tasks.get(decodeURIComponent(videoMatch[1])));
      }
      return json(res, 404, { error: "接口不存在" });
    } catch (error) {
      ctx.logger?.warn?.(`[${PLUGIN_ID}] ${req.method} ${path}: ${publicError(error)}`);
      return json(res, 400, { error: publicError(error) });
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler
  }), `${PLUGIN_ID}: ComfyUI studio API`);

  ctx.effect(() => async () => {
    disposed = true;
    if (historyTimer) clearTimeout(historyTimer);
    for (const task of tasks.values()) if (task.poller) clearInterval(task.poller);
    for (const socket of sockets) socket.close();
    sockets.clear();
    const ephemeralDispatchers = [...tasks.values()]
      .map((task) => task.connection)
      .filter((connection) => connection?.ephemeral && connection.dispatcher)
      .map((connection) => connection.dispatcher.close());
    await Promise.all(ephemeralDispatchers);
    await connectionCatalog.close();
    await persistHistory().catch((error) => ctx.logger?.warn?.(`[${PLUGIN_ID}] final history write failed: ${publicError(error)}`));
  }, `${PLUGIN_ID}: stop background task monitors`);

  void workflowReady.catch((error) => {
    if (!disposed) ctx.logger?.error?.(`[${PLUGIN_ID}] workflow preset load failed: ${publicError(error)}`);
  });
}
