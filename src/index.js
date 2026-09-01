import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { Agent } from "undici";
import WebSocket from "ws";
import {
  analyzeWorkflow,
  applyWorkflowValues,
  createWorkflowRegistry,
  parseApiWorkflow
} from "./workflow-presets.js";

const PLUGIN_ID = "dsh-comfy-video-studio";
const API_PREFIX = "/comfy-video/api";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const ACTIVE = new Set(["submitting", "remote_queued", "running", "finalizing", "writing"]);

export const inject = ["webServer"];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

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
  if (error?.name === "AbortError") return "请求超时";
  return error instanceof Error ? error.message : String(error);
}

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error(`请求体超过 ${limit} 字节限制`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit = 8 * 1024 * 1024) {
  const bytes = await readBody(req, limit);
  if (bytes.length === 0) return {};
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("请求体不是有效 JSON"); }
}

function integer(value, fallback, min, max) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("ComfyUI 地址必须使用 http 或 https");
  if (parsed.username || parsed.password) throw new Error("ComfyUI 地址不能包含用户名或密码，请由反向代理处理认证");
  return parsed.toString().replace(/\/$/, "");
}

function websocketUrl(baseUrl, clientId) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  url.search = new URLSearchParams({ clientId }).toString();
  return url.toString();
}

function publicConnection(connection) {
  return {
    id: connection.id,
    name: connection.name,
    baseUrl: connection.baseUrl,
    allowSelfSigned: connection.allowSelfSigned === true,
    maxConcurrency: connection.maxConcurrency,
    mutable: connection.origin === "runtime"
  };
}

function createConnectionCatalog(rawConfig, fallbackBaseUrl, storageFile, logger, onChange) {
  const source = Array.isArray(rawConfig.connectionPresets) && rawConfig.connectionPresets.length
    ? rawConfig.connectionPresets
    : [{ id: "default", name: "默认 ComfyUI", baseUrl: fallbackBaseUrl, maxConcurrency: 1 }];
  const presets = new Map();
  const configuredIds = new Set();
  const retiredDispatchers = new Set();
  let writeChain = Promise.resolve();
  let defaultId = String(rawConfig.defaultConnectionPresetId || source[0].id);

  function materialize(item, origin) {
    const id = String(item?.id || "").trim();
    const name = String(item?.name || "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(id)) throw new Error("连接 ID 无效");
    if (!name || name.length > 120) throw new Error("连接名称无效");
    const baseUrl = normalizeBaseUrl(item?.baseUrl);
    const allowSelfSigned = item?.allowSelfSigned === true;
    if (allowSelfSigned && !baseUrl.startsWith("https:")) throw new Error("自签名证书选项只适用于 HTTPS");
    return {
      id,
      name,
      baseUrl,
      allowSelfSigned,
      maxConcurrency: integer(item?.maxConcurrency, 1, 1, 3),
      origin,
      dispatcher: allowSelfSigned ? new Agent({ connect: { rejectUnauthorized: false } }) : null
    };
  }

  for (const item of source) {
    const preset = materialize(item, "configured");
    if (presets.has(preset.id)) throw new Error(`连接 ID 重复：${preset.id}`);
    configuredIds.add(preset.id);
    presets.set(preset.id, preset);
  }
  if (!presets.has(defaultId)) defaultId = presets.keys().next().value;

  function persist() {
    const payload = {
      version: 2,
      defaultId,
      presets: [...presets.values()].filter((item) => item.origin === "runtime").map(publicConnection),
      configuredConcurrency: Object.fromEntries([...presets.values()].filter((item) => item.origin === "configured").map((item) => [item.id, item.maxConcurrency]))
    };
    writeChain = writeChain.catch(() => {}).then(async () => {
      await mkdir(dirname(storageFile), { recursive: true });
      const temporary = `${storageFile}.partial-${process.pid}-${randomUUID()}`;
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(temporary, storageFile);
    });
    return writeChain;
  }

  async function load() {
    let parsed;
    try { parsed = JSON.parse(await readFile(storageFile, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT") logger?.warn?.(`[${PLUGIN_ID}] connection load failed: ${publicError(error)}`);
      return;
    }
    for (const item of Array.isArray(parsed?.presets) ? parsed.presets : []) {
      try {
        const preset = materialize(item, "runtime");
        if (configuredIds.has(preset.id)) throw new Error(`运行时连接与静态连接 ID 冲突：${preset.id}`);
        presets.set(preset.id, preset);
      } catch (error) {
        logger?.warn?.(`[${PLUGIN_ID}] ignored connection: ${publicError(error)}`);
      }
    }
    for (const [id, value] of Object.entries(parsed?.configuredConcurrency || {})) {
      const preset = presets.get(id);
      if (preset?.origin === "configured") preset.maxConcurrency = integer(value, preset.maxConcurrency, 1, 3);
    }
    if (presets.has(parsed?.defaultId)) defaultId = parsed.defaultId;
  }

  function get(id) {
    const key = String(id || defaultId);
    const connection = presets.get(key);
    if (!connection) throw new Error(`ComfyUI 连接不存在：${key}`);
    return connection;
  }

  async function save(payload) {
    const requestedId = String(payload?.id || "").trim();
    if (requestedId && configuredIds.has(requestedId)) throw new Error("静态连接不能在页面修改");
    const id = requestedId || `connection-${randomUUID()}`;
    const next = materialize({ ...payload, id }, "runtime");
    const previous = presets.get(id);
    if (previous?.dispatcher) retiredDispatchers.add(previous.dispatcher);
    presets.set(id, next);
    if (payload?.makeDefault === true) defaultId = id;
    await persist();
    onChange?.(id);
    return { preset: publicConnection(next), catalog: list() };
  }

  async function updateQueue(id, maxConcurrency) {
    const connection = get(id);
    connection.maxConcurrency = integer(maxConcurrency, connection.maxConcurrency, 1, 3);
    await persist();
    onChange?.(connection.id);
    return publicConnection(connection);
  }

  async function remove(id) {
    const connection = get(id);
    if (connection.origin !== "runtime") throw new Error("静态连接不能删除");
    presets.delete(connection.id);
    if (connection.dispatcher) retiredDispatchers.add(connection.dispatcher);
    if (defaultId === connection.id) defaultId = presets.keys().next().value;
    await persist();
    onChange?.(connection.id);
    return { removed: 1, defaultId };
  }

  function list() {
    return { defaultId, storageFile, presets: [...presets.values()].map(publicConnection) };
  }

  async function close() {
    const dispatchers = new Set([...presets.values(), ...[...retiredDispatchers].map((dispatcher) => ({ dispatcher }))].map((item) => item.dispatcher).filter(Boolean));
    await Promise.all([...dispatchers].map((dispatcher) => dispatcher.close()));
  }

  return { load, get, save, updateQueue, remove, list, close };
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

function findVideos(value, nodeId, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) findVideos(item, nodeId, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  if (typeof value.filename === "string" && /\.(mp4|webm|mov|mkv|gif)$/i.test(value.filename)) {
    result.push({
      nodeId: String(nodeId),
      filename: value.filename,
      subfolder: typeof value.subfolder === "string" ? value.subfolder : "",
      type: typeof value.type === "string" ? value.type : "output"
    });
  }
  for (const item of Object.values(value)) findVideos(item, nodeId, result);
  return result;
}

function videoDescriptors(outputs) {
  const result = [];
  for (const [nodeId, value] of Object.entries(outputs || {})) findVideos(value, nodeId, result);
  return result;
}

async function availablePath(directory, filename, suffix) {
  const safe = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  const extension = extname(safe);
  const stem = safe.slice(0, safe.length - extension.length);
  let candidate = join(directory, safe);
  try { await access(candidate); candidate = join(directory, `${stem}-${suffix}${extension}`); }
  catch { return candidate; }
  return candidate;
}

function taskView(task) {
  const outputs = Array.isArray(task.outputs) ? task.outputs.map((item, index) => ({
    ...item,
    videoUrl: item.outputPath ? `${API_PREFIX}/video/${encodeURIComponent(task.id)}/${index}` : null
  })) : [];
  const primaryIndex = Math.max(0, outputs.findIndex((item) => item.nodeId === task.primaryOutputNodeId));
  return {
    id: task.id,
    promptId: task.promptId,
    workflowId: task.workflowId,
    workflowName: task.workflowName,
    workflowHash: task.workflowHash,
    connectionPresetId: task.connection.id,
    connectionName: task.connection.name,
    connectionBaseUrl: task.connection.baseUrl,
    status: task.status,
    stage: task.stage,
    currentNode: task.currentNode,
    progress: task.progress,
    queueRemaining: task.queueRemaining,
    outputDirectory: task.outputDirectory,
    outputs,
    primaryOutputNodeId: task.primaryOutputNodeId,
    videoUrl: outputs[primaryIndex]?.videoUrl || null,
    error: task.error,
    warning: task.warning || null,
    legacy: task.legacy === true,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function outputDirectory(value) {
  const directory = String(value || "").trim();
  if (!isAbsolute(directory)) throw new Error("输出目录必须是 DeepSeek Harness 主机上的绝对路径");
  return resolve(directory);
}

export function apply(ctx, rawConfig = {}) {
  const dshHome = resolve(process.env.DSH_HOME || join(homedir(), ".dsh"));
  const config = {
    baseUrl: rawConfig.baseUrl || "http://127.0.0.1:8188",
    maxUploadMb: Number(rawConfig.maxUploadMb || 100),
    maxWorkflowMb: Number(rawConfig.maxWorkflowMb || 5),
    requestTimeoutMs: integer(rawConfig.requestTimeoutMs, 30000, 1000, 300000),
    historyLimit: integer(rawConfig.historyLimit, 200, 10, 2000),
    historyFile: resolve(rawConfig.historyFile || join(dshHome, "storages", PLUGIN_ID, "history.json")),
    connectionsFile: resolve(rawConfig.connectionsFile || join(dshHome, "storages", PLUGIN_ID, "connections.json")),
    workflowDirectory: resolve(rawConfig.workflowDirectory || join(dshHome, "storages", PLUGIN_ID, "workflows"))
  };
  const tasks = new Map();
  const sockets = new Set();
  const objectInfoCache = new Map();
  const dispatching = new Set();
  let disposed = false;
  let historyTimer = null;
  let historyWrite = Promise.resolve();
  let retryTimer = null;

  const scheduleConnection = (id) => {
    objectInfoCache.clear();
    queueMicrotask(() => void dispatchConnection(id));
  };
  const connectionCatalog = createConnectionCatalog(rawConfig, config.baseUrl, config.connectionsFile, ctx.logger, scheduleConnection);
  const workflowRegistry = createWorkflowRegistry({ directory: config.workflowDirectory, logger: ctx.logger });
  const connectionReady = connectionCatalog.load();
  const workflowReady = workflowRegistry.load();

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
        const detail = (await response.text()).slice(0, 1200);
        throw new Error(`ComfyUI ${response.status}: ${detail || response.statusText}`);
      }
      return response;
    } finally { clearTimeout(timer); }
  }

  async function comfyJson(connection, pathname, init, timeoutMs) {
    return (await comfy(connection, pathname, init, timeoutMs)).json();
  }

  async function getObjectInfo(connection, force = false) {
    const cacheKey = `${connection.id}\u0000${connection.baseUrl}`;
    const cached = objectInfoCache.get(cacheKey);
    if (!force && cached && Date.now() - cached.fetchedAt < 60000) return cached.value;
    const value = await comfyJson(connection, "/object_info");
    objectInfoCache.set(cacheKey, { value, fetchedAt: Date.now() });
    return value;
  }

  async function inspectConnection(connection, includeObjectInfo = false) {
    const startedAt = Date.now();
    const [statsResult, queueResult] = await Promise.allSettled([
      comfyJson(connection, "/system_stats"),
      comfyJson(connection, "/queue")
    ]);
    if (statsResult.status === "rejected") throw statsResult.reason;
    const queue = queueResult.status === "fulfilled" ? queueResult.value : null;
    const result = {
      ok: true,
      status: queue ? "online" : "degraded",
      connection: publicConnection(connection),
      latencyMs: Date.now() - startedAt,
      stats: statsResult.value,
      queue: queue ? {
        running: Array.isArray(queue.queue_running) ? queue.queue_running.length : 0,
        pending: Array.isArray(queue.queue_pending) ? queue.queue_pending.length : 0
      } : null,
      queueError: queueResult.status === "rejected" ? publicError(queueResult.reason) : null,
      checkedAt: Date.now()
    };
    if (includeObjectInfo) result.objectInfoNodeCount = Object.keys(await getObjectInfo(connection, true)).length;
    return result;
  }

  async function inspectCompatibility(workflow, fields, connection, force = false) {
    const objectInfo = await getObjectInfo(connection, force);
    return analyzeWorkflow(workflow, objectInfo, fields);
  }

  function taskRecord(task) {
    return {
      ...taskView(task),
      clientId: task.clientId,
      values: clone(task.values || {}),
      workflowSnapshot: task.workflowSnapshot ? clone(task.workflowSnapshot) : null,
      fieldSnapshot: task.fieldSnapshot ? clone(task.fieldSnapshot) : null,
      connectionSnapshot: publicConnection(task.connection)
    };
  }

  function persistHistory() {
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = null;
    const records = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, config.historyLimit).map(taskRecord);
    historyWrite = historyWrite.catch(() => {}).then(async () => {
      await mkdir(dirname(config.historyFile), { recursive: true });
      const temporary = `${config.historyFile}.partial-${process.pid}-${randomUUID()}`;
      await writeFile(temporary, `${JSON.stringify({ version: 3, tasks: records }, null, 2)}\n`, "utf8");
      await rename(temporary, config.historyFile);
    });
    return historyWrite;
  }

  function scheduleHistory() {
    if (disposed || historyTimer) return;
    historyTimer = setTimeout(() => {
      historyTimer = null;
      void persistHistory().catch((error) => ctx.logger?.warn?.(`[${PLUGIN_ID}] history write failed: ${publicError(error)}`));
    }, 200);
  }

  function touch(task, patch) {
    Object.assign(task, patch, { updatedAt: Date.now() });
    scheduleHistory();
  }

  function ephemeralConnection(record) {
    const snapshot = record?.connectionSnapshot || {};
    try {
      const current = connectionCatalog.get(record?.connectionPresetId || snapshot.id);
      if (!snapshot.baseUrl || current.baseUrl === snapshot.baseUrl && current.allowSelfSigned === (snapshot.allowSelfSigned === true)) return current;
    } catch { /* fall through to the persisted task snapshot */ }
    {
      const allowSelfSigned = snapshot.allowSelfSigned === true;
      return {
        id: String(snapshot.id || record?.connectionPresetId || "retired"),
        name: String(snapshot.name || record?.connectionName || "已删除连接"),
        baseUrl: normalizeBaseUrl(snapshot.baseUrl || record?.connectionBaseUrl),
        allowSelfSigned,
        maxConcurrency: integer(snapshot.maxConcurrency, 1, 1, 3),
        origin: "snapshot",
        dispatcher: allowSelfSigned ? new Agent({ connect: { rejectUnauthorized: false } }) : null,
        ephemeral: true
      };
    }
  }

  function hydrateTask(record) {
    const legacy = !record?.workflowSnapshot;
    let status = String(record?.status || "failed");
    if (status === "queued") status = record?.promptId ? "remote_queued" : legacy ? "failed" : "waiting";
    if (status === "connecting") status = record?.promptId ? "remote_queued" : legacy ? "failed" : "waiting";
    if (!["waiting", "submitting", "remote_queued", "running", "finalizing", "writing", "completed", "failed", "cancelled"].includes(status)) status = "failed";
    if (status === "submitting" && !record?.promptId) status = "failed";
    const outputs = Array.isArray(record?.outputs) ? record.outputs : record?.outputPath ? [{ nodeId: String(record.primaryOutputNodeId || "legacy"), outputPath: record.outputPath, filename: String(record.outputPath).split(/[\\/]/).pop() }] : [];
    return {
      id: String(record?.id || randomUUID()),
      promptId: record?.promptId ? String(record.promptId) : null,
      clientId: String(record?.clientId || randomUUID()),
      workflowId: String(record?.workflowId || record?.workflowPresetId || "legacy"),
      workflowName: String(record?.workflowName || record?.workflowPresetId || "旧版任务"),
      workflowHash: String(record?.workflowHash || ""),
      workflowSnapshot: record?.workflowSnapshot || null,
      fieldSnapshot: Array.isArray(record?.fieldSnapshot) ? record.fieldSnapshot : null,
      values: record?.values && typeof record.values === "object" ? record.values : {},
      connection: ephemeralConnection(record),
      primaryOutputNodeId: String(record?.primaryOutputNodeId || outputs[0]?.nodeId || ""),
      outputDirectory: String(record?.outputDirectory || ""),
      outputs,
      status,
      stage: status === "failed" && record?.status === "submitting" ? "Harness 重启时任务尚未取得 prompt_id" : String(record?.stage || "历史任务"),
      currentNode: record?.currentNode ?? null,
      progress: record?.progress || { value: 0, max: 0, percent: null },
      queueRemaining: record?.queueRemaining ?? null,
      error: status === "failed" && record?.status === "submitting" ? "为避免重复生成，未自动重提" : record?.error || null,
      warning: record?.warning || null,
      legacy,
      createdAt: Number(record?.createdAt) || Date.now(),
      updatedAt: Number(record?.updatedAt) || Date.now(),
      socket: null,
      poller: null,
      finalizing: false
    };
  }

  async function loadHistory() {
    let parsed;
    try { parsed = JSON.parse(await readFile(config.historyFile, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT") ctx.logger?.warn?.(`[${PLUGIN_ID}] history load failed: ${publicError(error)}`);
      return;
    }
    for (const record of Array.isArray(parsed?.tasks) ? parsed.tasks.slice(0, config.historyLimit) : []) {
      const task = hydrateTask(record);
      tasks.set(task.id, task);
    }
    for (const task of tasks.values()) {
      if (task.status === "waiting") scheduleConnection(task.connection.id);
      else if (task.promptId && ACTIVE.has(task.status)) {
        void connectSocket(task).catch(() => {});
        startHistoryFallback(task);
      }
    }
  }

  const historyReady = Promise.all([connectionReady, workflowReady]).then(loadHistory);

  async function upload(req, connection) {
    const bytes = await readBody(req, Math.round(config.maxUploadMb * 1024 * 1024));
    if (bytes.length === 0) throw new Error("上传文件为空");
    const rawName = req.headers["x-file-name"];
    const filename = decodeURIComponent(Array.isArray(rawName) ? rawName[0] : rawName || "input.bin").split(/[\\/]/).pop();
    const mime = String(req.headers["content-type"] || "application/octet-stream");
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: mime }), filename);
    form.append("type", "input");
    form.append("overwrite", "false");
    return (await comfy(connection, "/upload/image", { method: "POST", body: form })).json();
  }

  async function copyOutput(task, descriptor, index) {
    await mkdir(task.outputDirectory, { recursive: true });
    const filename = descriptor.filename.split(/[\\/]/).pop() || `video-${task.id}-${index}.mp4`;
    const destination = await availablePath(task.outputDirectory, filename, `${task.id.slice(0, 8)}-${index}`);
    const temporary = `${destination}.partial-${task.id}`;
    const params = new URLSearchParams({ filename: descriptor.filename, subfolder: descriptor.subfolder || "", type: descriptor.type || "output" });
    const response = await comfy(task.connection, `/view?${params}`, {}, 24 * 60 * 60 * 1000);
    if (!response.body) throw new Error("ComfyUI 视频响应没有内容");
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return { ...descriptor, outputPath: destination };
  }

  async function finalize(task) {
    if (task.finalizing || TERMINAL.has(task.status)) return;
    task.finalizing = true;
    try {
      touch(task, { status: "finalizing", stage: "正在读取工作流视频输出" });
      const history = await comfyJson(task.connection, `/history/${encodeURIComponent(task.promptId)}`);
      const record = history?.[task.promptId] ?? history;
      const descriptors = videoDescriptors(record?.outputs || {});
      if (descriptors.length === 0) throw new Error("工作流已结束，但历史记录中没有视频输出");
      touch(task, { status: "writing", stage: `正在保存 ${descriptors.length} 个视频输出` });
      const saved = [];
      for (let index = 0; index < descriptors.length; index += 1) saved.push(await copyOutput(task, descriptors[index], index));
      const hasPrimary = saved.some((item) => item.nodeId === task.primaryOutputNodeId);
      touch(task, {
        status: "completed",
        stage: "制作完成",
        progress: { value: 1, max: 1, percent: 100 },
        outputs: saved,
        warning: hasPrimary ? null : "主输出节点没有返回视频，已显示第一个可用视频"
      });
    } catch (error) {
      touch(task, { status: "failed", stage: "结果处理失败", error: publicError(error) });
    } finally {
      task.finalizing = false;
      if (task.poller) clearInterval(task.poller);
      task.poller = null;
      task.socket?.close();
      scheduleConnection(task.connection.id);
    }
  }

  function watchSocket(task, socket) {
    socket.on("message", (raw) => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch { return; }
      const data = event.data || {};
      if (data.prompt_id && task.promptId && data.prompt_id !== task.promptId) return;
      if (event.type === "status") {
        const remaining = data.status?.exec_info?.queue_remaining;
        if (Number.isFinite(remaining)) touch(task, { queueRemaining: remaining });
      } else if (event.type === "execution_start") {
        touch(task, { status: "running", stage: "ComfyUI 开始执行" });
      } else if (event.type === "executing") {
        if (data.node === null) void finalize(task);
        else touch(task, { status: "running", stage: "正在执行节点", currentNode: data.node ?? null });
      } else if (event.type === "progress") {
        const value = Number(data.value || 0);
        const max = Number(data.max || 0);
        touch(task, { status: "running", stage: "正在执行工作流", progress: { value, max, percent: max > 0 ? Math.round(value / max * 100) : null } });
      } else if (event.type === "execution_success") {
        void finalize(task);
      } else if (["execution_error", "execution_interrupted"].includes(event.type)) {
        touch(task, {
          status: event.type === "execution_interrupted" ? "cancelled" : "failed",
          stage: event.type === "execution_interrupted" ? "已取消" : "执行失败",
          error: data.exception_message || data.error || null
        });
        if (task.poller) clearInterval(task.poller);
        task.poller = null;
        task.socket?.close();
        scheduleConnection(task.connection.id);
      }
    });
    socket.on("error", (error) => ctx.logger?.warn?.(`[${PLUGIN_ID}] websocket: ${publicError(error)}`));
    socket.on("close", () => sockets.delete(socket));
  }

  async function connectSocket(task) {
    if (task.socket && task.socket.readyState <= 1) return;
    const socket = new WebSocket(websocketUrl(task.connection.baseUrl, task.clientId), { rejectUnauthorized: !task.connection.allowSelfSigned });
    task.socket = socket;
    sockets.add(socket);
    watchSocket(task, socket);
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error("WebSocket 连接超时")), 5000);
      socket.once("open", () => { clearTimeout(timer); resolveOpen(); });
      socket.once("error", (error) => { clearTimeout(timer); rejectOpen(error); });
    });
  }

  function startHistoryFallback(task) {
    if (task.poller) return;
    task.poller = setInterval(async () => {
      if (!task.promptId || TERMINAL.has(task.status)) return;
      try {
        const history = await comfyJson(task.connection, `/history/${encodeURIComponent(task.promptId)}`);
        if (history?.[task.promptId] || history?.outputs) await finalize(task);
      } catch { /* transient while running */ }
    }, 2500);
  }

  async function submitTask(task) {
    let compatibility;
    try { compatibility = await inspectCompatibility(task.workflowSnapshot, task.fieldSnapshot, task.connection, true); }
    catch (error) {
      touch(task, { status: "waiting", stage: "服务器离线，等待恢复", error: publicError(error) });
      return;
    }
    if (!compatibility.ok) {
      touch(task, { status: "failed", stage: "工作流与服务器不兼容", error: "请重新运行兼容性检测并修复缺失节点、模型或端口" });
      scheduleConnection(task.connection.id);
      return;
    }
    let prompt;
    try {
      task.fieldSnapshot = compatibility.fields;
      prompt = applyWorkflowValues(task.workflowSnapshot, compatibility.fields.filter((field) => field.visible), task.values);
    }
    catch (error) {
      touch(task, { status: "failed", stage: "参数校验失败", error: publicError(error) });
      scheduleConnection(task.connection.id);
      return;
    }
    await connectSocket(task).catch((error) => touch(task, { stage: `实时通道不可用，使用轮询：${publicError(error)}` }));
    try {
      const answer = await comfyJson(task.connection, "/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, client_id: task.clientId })
      });
      if (!answer.prompt_id) throw new Error("ComfyUI 未返回 prompt_id");
      touch(task, { promptId: answer.prompt_id, status: "remote_queued", stage: "已提交到 ComfyUI 队列", error: null });
      startHistoryFallback(task);
    } catch (error) {
      touch(task, { status: "failed", stage: "提交状态不确定，为避免重复生成已停止", error: publicError(error) });
      task.socket?.close();
      scheduleConnection(task.connection.id);
    }
  }

  async function dispatchConnection(connectionId) {
    if (disposed || dispatching.has(connectionId)) return;
    dispatching.add(connectionId);
    try {
      let connection;
      try { connection = connectionCatalog.get(connectionId); } catch { return; }
      const activeCount = [...tasks.values()].filter((task) => task.connection.id === connectionId && ACTIVE.has(task.status)).length;
      const capacity = Math.max(0, connection.maxConcurrency - activeCount);
      const waiting = [...tasks.values()]
        .filter((task) => task.connection.id === connectionId && task.status === "waiting")
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, capacity);
      for (const task of waiting) {
        touch(task, { status: "submitting", stage: "正在校验服务器并准备提交", error: null });
        void submitTask(task);
      }
    } finally { dispatching.delete(connectionId); }
  }

  async function createTask(payload) {
    await Promise.all([historyReady, workflowReady, connectionReady]);
    const workflow = workflowRegistry.get(payload?.workflowId);
    const connection = connectionCatalog.get(payload?.connectionPresetId);
    const values = payload?.values && typeof payload.values === "object" ? payload.values : {};
    let compatibility = null;
    try { compatibility = await inspectCompatibility(workflow.workflow, workflow.fields, connection, true); }
    catch { /* offline tasks stay local */ }
    if (compatibility && !compatibility.ok) throw new Error("工作流与所选服务器不兼容，请先查看缺失节点、模型或端口报告");
    applyWorkflowValues(workflow.workflow, (compatibility?.fields || workflow.fields).filter((field) => field.visible), values);
    const task = {
      id: randomUUID(),
      promptId: null,
      clientId: randomUUID(),
      workflowId: workflow.id,
      workflowName: workflow.name,
      workflowHash: workflow.hash,
      workflowSnapshot: clone(workflow.workflow),
      fieldSnapshot: clone(compatibility?.fields || workflow.fields),
      values: clone(values),
      connection,
      primaryOutputNodeId: workflow.primaryOutputNodeId,
      outputDirectory: outputDirectory(payload?.outputDirectory),
      outputs: [],
      status: "waiting",
      stage: compatibility ? "等待本地调度槽" : "服务器离线，等待恢复",
      currentNode: null,
      progress: { value: 0, max: 0, percent: null },
      queueRemaining: null,
      error: null,
      warning: connection.maxConcurrency > 1 ? "标准单 GPU ComfyUI 可能仍会串行执行远端队列" : null,
      legacy: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      socket: null,
      poller: null,
      finalizing: false
    };
    tasks.set(task.id, task);
    scheduleHistory();
    scheduleConnection(connection.id);
    return taskView(task);
  }

  async function cancelTask(task) {
    if (TERMINAL.has(task.status)) return;
    if (task.status === "waiting" || task.status === "submitting" && !task.promptId) {
      touch(task, { status: "cancelled", stage: "已从本地队列取消" });
    } else if (task.status === "remote_queued" && task.promptId) {
      await comfy(task.connection, "/queue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete: [task.promptId] }) });
      touch(task, { status: "cancelled", stage: "已从 ComfyUI 队列取消" });
    } else {
      await comfy(task.connection, "/interrupt", { method: "POST" });
      touch(task, { status: "cancelled", stage: "已中断服务器当前任务" });
    }
    if (task.poller) clearInterval(task.poller);
    task.poller = null;
    task.socket?.close();
    scheduleConnection(task.connection.id);
  }

  async function serveVideo(req, res, task, outputIndex) {
    const output = task?.outputs?.[outputIndex];
    if (!output?.outputPath) return json(res, 404, { error: "视频不存在" });
    let info;
    try { info = await stat(output.outputPath); } catch { return json(res, 404, { error: "视频文件不存在" }); }
    const type = contentType(output.outputPath);
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { "content-type": type, "content-length": info.size, "accept-ranges": "bytes", "cache-control": "private, no-cache" });
      if (req.method === "HEAD") return res.end();
      return createReadStream(output.outputPath).pipe(res);
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) { res.writeHead(416, { "content-range": `bytes */${info.size}` }); return res.end(); }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) { res.writeHead(416, { "content-range": `bytes */${info.size}` }); return res.end(); }
    res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${info.size}`, "accept-ranges": "bytes", "cache-control": "private, no-cache" });
    if (req.method === "HEAD") return res.end();
    createReadStream(output.outputPath, { start, end }).pipe(res);
  }

  retryTimer = setInterval(() => {
    const ids = new Set([...tasks.values()].filter((task) => task.status === "waiting").map((task) => task.connection.id));
    for (const id of ids) void dispatchConnection(id);
  }, 10000);

  async function handler(req, res) {
    const url = new URL(req.url || "/", "http://dsh.local");
    const path = url.pathname.slice(API_PREFIX.length) || "/";
    try {
      await Promise.all([historyReady, workflowReady, connectionReady]);

      if (req.method === "GET" && path === "/connections") return json(res, 200, connectionCatalog.list());
      if (req.method === "POST" && path === "/connections") return json(res, 200, await connectionCatalog.save(await readJson(req)));
      const connectionHealthMatch = /^\/connections\/([^/]+)\/health$/.exec(path);
      if (req.method === "GET" && connectionHealthMatch) {
        return json(res, 200, await inspectConnection(connectionCatalog.get(decodeURIComponent(connectionHealthMatch[1])), url.searchParams.get("deep") === "1"));
      }
      const connectionQueueMatch = /^\/connections\/([^/]+)\/queue$/.exec(path);
      if (req.method === "PATCH" && connectionQueueMatch) {
        const id = decodeURIComponent(connectionQueueMatch[1]);
        const result = await connectionCatalog.updateQueue(id, (await readJson(req)).maxConcurrency);
        scheduleConnection(id);
        return json(res, 200, result);
      }
      const connectionMatch = /^\/connections\/([^/]+)$/.exec(path);
      if (req.method === "PATCH" && connectionMatch) return json(res, 200, await connectionCatalog.save({ ...(await readJson(req)), id: decodeURIComponent(connectionMatch[1]) }));
      if (req.method === "DELETE" && connectionMatch) {
        const id = decodeURIComponent(connectionMatch[1]);
        if ([...tasks.values()].some((task) => task.connection.id === id && !TERMINAL.has(task.status))) throw new Error("该服务器仍有等待或运行任务，不能删除");
        return json(res, 200, await connectionCatalog.remove(id));
      }

      if (req.method === "POST" && path === "/workflows/inspect") {
        const workflow = parseApiWorkflow(await readBody(req, Math.round(config.maxWorkflowMb * 1024 * 1024)));
        const connectionId = url.searchParams.get("connectionPresetId");
        const analysis = connectionId
          ? await inspectCompatibility(workflow, null, connectionCatalog.get(connectionId), true)
          : analyzeWorkflow(workflow);
        return json(res, 200, { analysis });
      }
      if (req.method === "GET" && path === "/workflows") return json(res, 200, workflowRegistry.list());
      if (req.method === "POST" && path === "/workflows") return json(res, 201, await workflowRegistry.save(await readJson(req)));
      const compatibilityMatch = /^\/workflows\/([^/]+)\/compatibility$/.exec(path);
      if (req.method === "GET" && compatibilityMatch) {
        const workflow = workflowRegistry.get(decodeURIComponent(compatibilityMatch[1]));
        const connection = connectionCatalog.get(url.searchParams.get("connectionPresetId"));
        return json(res, 200, await inspectCompatibility(workflow.workflow, workflow.fields, connection, url.searchParams.get("force") === "1"));
      }
      const workflowMatch = /^\/workflows\/([^/]+)$/.exec(path);
      if (req.method === "GET" && workflowMatch) return json(res, 200, workflowRegistry.get(decodeURIComponent(workflowMatch[1])));
      if (req.method === "PATCH" && workflowMatch) return json(res, 200, await workflowRegistry.update(decodeURIComponent(workflowMatch[1]), await readJson(req)));
      if (req.method === "DELETE" && workflowMatch) return json(res, 200, await workflowRegistry.remove(decodeURIComponent(workflowMatch[1])));

      if (req.method === "POST" && path === "/upload") {
        return json(res, 200, await upload(req, connectionCatalog.get(url.searchParams.get("connectionPresetId"))));
      }
      if (req.method === "GET" && path === "/tasks") return json(res, 200, [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).map(taskView));
      if (req.method === "POST" && path === "/tasks") return json(res, 202, await createTask(await readJson(req)));
      if (req.method === "DELETE" && path === "/tasks") {
        let removed = 0;
        for (const [id, task] of tasks) if (TERMINAL.has(task.status)) { tasks.delete(id); removed += 1; }
        await persistHistory();
        return json(res, 200, { removed });
      }
      const taskCancelMatch = /^\/tasks\/([^/]+)\/cancel$/.exec(path);
      if (req.method === "POST" && taskCancelMatch) {
        const task = tasks.get(decodeURIComponent(taskCancelMatch[1]));
        if (!task) return json(res, 404, { error: "任务不存在" });
        await cancelTask(task);
        return json(res, 200, taskView(task));
      }
      const taskMatch = /^\/tasks\/([^/]+)$/.exec(path);
      if (req.method === "GET" && taskMatch) {
        const task = tasks.get(decodeURIComponent(taskMatch[1]));
        return task ? json(res, 200, taskView(task)) : json(res, 404, { error: "任务不存在" });
      }
      const videoMatch = /^\/video\/([^/]+)\/(\d+)$/.exec(path);
      if ((req.method === "GET" || req.method === "HEAD") && videoMatch) {
        return serveVideo(req, res, tasks.get(decodeURIComponent(videoMatch[1])), Number(videoMatch[2]));
      }
      return json(res, 404, { error: "接口不存在" });
    } catch (error) {
      ctx.logger?.warn?.(`[${PLUGIN_ID}] ${req.method} ${path}: ${publicError(error)}`);
      return json(res, 400, { error: publicError(error) });
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: API_PREFIX, handler }), `${PLUGIN_ID}: dynamic ComfyUI workflow API`);
  ctx.effect(() => async () => {
    disposed = true;
    if (retryTimer) clearInterval(retryTimer);
    if (historyTimer) clearTimeout(historyTimer);
    for (const task of tasks.values()) if (task.poller) clearInterval(task.poller);
    for (const socket of sockets) socket.close();
    sockets.clear();
    const ephemeralDispatchers = new Set([...tasks.values()].filter((task) => task.connection?.ephemeral && task.connection.dispatcher).map((task) => task.connection.dispatcher));
    await Promise.all([...ephemeralDispatchers].map((dispatcher) => dispatcher.close()));
    await connectionCatalog.close();
    await persistHistory().catch((error) => ctx.logger?.warn?.(`[${PLUGIN_ID}] final history write failed: ${publicError(error)}`));
  }, `${PLUGIN_ID}: stop schedulers and monitors`);
}
