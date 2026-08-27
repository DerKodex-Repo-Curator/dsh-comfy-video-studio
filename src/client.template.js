const React = require("react");
const { createElement: h, useEffect, useRef, useState, useSyncExternalStore } = React;

const PACKAGE_ID = "dsh-comfy-video-studio";
const STYLE_ID = `${PACKAGE_ID}/studio.css`;
const STUDIO_CSS = __STUDIO_CSS__;
const API = "/comfy-video/api";

const visibility = {
  value: false,
  listeners: new Set(),
  getSnapshot() { return this.value; },
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
  set(next) { this.value = next; for (const listener of this.listeners) listener(); }
};

const BASE_VALUES = Object.freeze({
  prompt: "",
  image: "",
  keyframes: Object.freeze([{ ref: "K1", image: "", timeSeconds: 0 }]),
  connectionPresetId: "default",
  workflowPresetId: "minimax-h3-default",
  outputDirectory: "",
  resolutionPreset: "balanced",
  duration: 5,
  fps: 24,
  bitDepth: 8,
  steps: 20,
  denoise: 1,
  seed: Math.floor(Math.random() * 9007199254740990),
  scheduler: "simple",
  sampler: "res_multistep",
  format: "mp4",
  codec: "auto",
  unetName: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  weightDtype: "default",
  clipName: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  clipDevice: "default",
  videoVae: "minimax_h3_video_vae_fp16.safetensors",
  audioVae: "minimax_h3_audio_vae_fp32.safetensors"
});

async function api(path, init) {
  const response = await fetch(`${API}${path}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
  return payload;
}

const OPTIMIZATION_ACTIVE = new Set(["resolving-model", "analyzing", "handoff", "waiting", "finalizing"]);
const DEFAULT_RULE_TEXT = "默认采用 9:16 手机竖屏；镜头转动平滑连续、停顿不超过 500ms，并带轻微自然手持抖动；运镜时人物头部、身体方向和视线不追随镜头；人物平均每 3-8 秒自然眨眼一次，短于 3 秒不强制眨眼。若我明确要求相反效果，以我的明确要求为准并避免提示词冲突。";
const RESOLUTIONS = Object.freeze({
  balanced: { label: "576×1024（显存均衡）", width: 576, height: 1024 },
  quality: { label: "768×1344（高清，近似 9:16）", width: 768, height: 1344 }
});
const EMPTY_CONNECTION_DRAFT = Object.freeze({ id: "", name: "", baseUrl: "", allowSelfSigned: false, makeDefault: false, mutable: true });

function nodeText(node) {
  if (node?.kind !== "assistant" || !Array.isArray(node.blocks)) return "";
  return node.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n");
}

function latestSequence(snapshot) {
  return Math.max(0, ...(snapshot?.nodes ?? []).map((node) => Number(node.seq) || 0));
}

function clarifiedPrompt(snapshot, token, afterSequence) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<COMFY_VIDEO_PROMPT\\s+id=["']${escaped}["']\\s*>([\\s\\S]*?)<\\/COMFY_VIDEO_PROMPT>`, "i");
  for (const node of [...(snapshot?.nodes ?? [])].reverse()) {
    if ((Number(node.seq) || 0) <= afterSequence) break;
    const match = nodeText(node).match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return "";
}

function clarificationInstruction({ token, mode, prompt, questions, duration, aspectRatio, keyframes }) {
  const kind = mode === "keyframe" ? "关键帧生成视频" : mode === "i2v" ? "图生视频" : "文生视频";
  return [
    "【视频工作台 · 提示词澄清】",
    `我正在为 MiniMax H3 准备${kind}提示词。请担任澄清主持人，不要调用工具，也不要开始生成视频。`,
    `原始描述：${prompt}`,
    `目标规格：${duration} 秒，${aspectRatio}。`,
    "以下问题会实质改变成片，请先简洁地逐项向我提问并等待回答：",
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    "如果我的回答仍存在会实质改变结果的歧义，继续追问，每次最多 3 个问题。不要追问可以采用保守默认值的审美偏好。",
    mode === "keyframe"
      ? `确认后，把这些引用视为静态状态约束：${keyframes.map((item) => `@${item.ref}=${item.timeSeconds}秒`).join(" → ")}。只描述相邻引用之间连续可实现的过渡，不用文字重写图片事实。`
      : mode === "i2v"
        ? "确认后，把参考图视为第一帧和静态视觉事实，只补充动作、环境运动、镜头运动、时序与稳定结束，不虚构图片中看不到的事实。"
        : "确认后，按主体与外观、环境、主体动作、环境运动、镜头、光线风格、分段时序组织完整提示词。",
    `最终提示词还必须遵守以下默认规则：${DEFAULT_RULE_TEXT}`,
    "最终确认完成时，先简短说明已确认，然后必须原样使用下面的标签包住唯一的最终提示词；标签 id 不得修改：",
    `<COMFY_VIDEO_PROMPT id="${token}">`,
    "这里放最终完整提示词",
    "</COMFY_VIDEO_PROMPT>"
  ].join("\n");
}

function VideoIcon({ size = 20 }) {
  return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
    h("path", { d: "M4.8 5.5h9.4A2.8 2.8 0 0 1 17 8.3v7.4a2.8 2.8 0 0 1-2.8 2.8H4.8A2.8 2.8 0 0 1 2 15.7V8.3a2.8 2.8 0 0 1 2.8-2.8Z", stroke: "currentColor", strokeWidth: 1.7 }),
    h("path", { d: "m17 10 4-2.3v8.6L17 14", stroke: "currentColor", strokeWidth: 1.7, strokeLinejoin: "round" }),
    h("path", { d: "m8.2 9.1 4.5 2.9-4.5 2.9V9.1Z", fill: "currentColor" })
  );
}

function SparkIcon({ size = 20 }) {
  return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
    h("path", { d: "M12 2.8c.6 4.2 2.9 6.5 7.2 7.2-4.3.7-6.6 3-7.2 7.2-.7-4.2-3-6.5-7.2-7.2C9 9.3 11.3 7 12 2.8Z", stroke: "currentColor", strokeWidth: 1.6, strokeLinejoin: "round" }),
    h("path", { d: "M19 16.2c.2 1.5 1.1 2.4 2.6 2.6-1.5.3-2.4 1.1-2.6 2.7-.3-1.6-1.1-2.4-2.7-2.7 1.6-.2 2.4-1.1 2.7-2.6Z", fill: "currentColor" })
  );
}

function StudioButton({ wide }) {
  return h("button", {
    type: "button",
    className: "cvs-launch",
    "data-wide": wide ? "true" : "false",
    title: "视频工作台",
    onClick: () => visibility.set(true)
  }, h(VideoIcon), wide ? h("span", null, "视频工作台") : null);
}

function Field({ label, valueLabel, children }) {
  return h("label", { className: "cvs-field" },
    h("span", { className: "cvs-label" }, h("span", null, label), valueLabel == null ? null : h("em", null, valueLabel)),
    children
  );
}

function Input({ value, onChange, ...props }) {
  return h("input", { className: "cvs-input", value, onChange: (event) => onChange(event.target.value), ...props });
}

function Select({ value, onChange, options }) {
  return h("select", { className: "cvs-select", value, onChange: (event) => onChange(event.target.value) },
    options.map((option) => h("option", { key: option, value: option }, option))
  );
}

function NumberInput({ value, onChange, ...props }) {
  return h(Input, { type: "number", value, onChange: (next) => onChange(Number(next)), ...props });
}

function Progress({ task }) {
  const percent = task?.progress?.percent;
  const busy = task && !["completed", "failed", "cancelled"].includes(task.status);
  const width = percent == null ? (busy ? 12 : task?.status === "completed" ? 100 : 0) : percent;
  return h("div", { className: "cvs-progress-card" },
    h("div", { className: "cvs-progress-head" },
      h("span", null, task?.stage || "等待制作任务"),
      h("span", null, percent == null ? (busy ? "处理中" : "—") : `${percent}%`)
    ),
    h("div", { className: "cvs-progress-track" }, h("div", { className: "cvs-progress-fill", style: { width: `${width}%` } })),
    task ? h("div", { className: "cvs-progress-meta" },
      h("span", null, `节点 ${task.currentNode || "—"}`),
      h("span", null, `队列 ${task.queueRemaining ?? "—"}`),
      task.outputPath ? h("span", null, "已落盘") : null
    ) : null,
    task?.error ? h("div", { className: "cvs-error" }, task.error) : null
  );
}

function TaskCard({ task, active, onClick }) {
  const labels = { connecting: "连接中", queued: "排队", running: "制作中", finalizing: "收尾", writing: "写入", completed: "完成", failed: "失败", cancelled: "取消" };
  const modeLabels = { t2v: "文生视频", i2v: "图生视频", keyframe: "关键帧视频" };
  return h("article", { className: "cvs-task", "data-active": active ? "true" : "false", onClick },
    h("div", { className: "cvs-task-head" },
      h("span", { className: "cvs-task-kind" }, modeLabels[task.mode] || task.mode),
      h("span", { className: "cvs-badge", "data-status": task.status }, labels[task.status] || task.status)
    ),
    h("div", { className: "cvs-task-prompt" }, task.prompt),
      task.workflowPresetId ? h("div", { className: "cvs-task-meta" }, `${task.connectionName || task.connectionPresetId || "ComfyUI"} · ${task.workflowPresetId}${task.keyframes?.length ? ` · ${task.keyframes.map((item) => `@${item.ref} ${Number(item.timeSeconds).toFixed(2)}s`).join(" / ")}` : ""}`) : null,
    h("div", { className: "cvs-task-time" }, new Date(task.createdAt).toLocaleString()),
    task.outputPath ? h("div", { className: "cvs-path" }, task.outputPath) : null
  );
}

function OptimizationStatus({ value, onShowPrompt, onCancel }) {
  if (!value || value.phase === "idle") return null;
  const active = OPTIMIZATION_ACTIVE.has(value.phase);
  const labels = {
    "resolving-model": "正在读取当前会话模型",
    analyzing: "正在检查歧义并规划视频提示词",
    handoff: "发现关键信息不明确，正在切换到对话",
    waiting: "等待你在对话中完成确认",
    finalizing: "已收到确认，正在回填工作台",
    completed: "AI 优化完成，提示词已覆盖",
    error: "AI 优化失败"
  };
  return h("div", { className: "cvs-opt-status", "data-phase": value.phase, role: "status", "aria-live": "polite" },
    h("div", { className: "cvs-opt-head" },
      h("span", { className: active ? "cvs-opt-spinner" : "cvs-opt-mark" }, active ? null : value.phase === "completed" ? "✓" : "!"),
      h("div", null,
        h("strong", null, labels[value.phase] || "AI 优化"),
        value.model ? h("span", null, value.model) : null
      )
    ),
    value.message ? h("div", { className: "cvs-opt-message" }, value.message) : null,
    value.questions?.length ? h("ol", { className: "cvs-opt-questions" }, value.questions.map((question) => h("li", { key: question }, question))) : null,
    value.phase === "completed" ? h("div", { className: "cvs-opt-meta" },
      h("span", null, `原始 ${value.originalPrompt?.length || 0} 字`),
      h("span", null, `优化后 ${value.optimizedPrompt?.length || 0} 字`)
    ) : null,
    h("div", { className: "cvs-opt-actions" },
      value.phase === "completed" ? h("button", { type: "button", className: "cvs-mini-button", onClick: onShowPrompt }, "查看完整提示词") : null,
      active ? h("button", { type: "button", className: "cvs-mini-button", onClick: onCancel }, "取消本次优化") : null
    )
  );
}

function PromptModal({ prompt, onChange, onClose, readOnly }) {
  return h("div", { className: "cvs-prompt-modal-backdrop", role: "presentation", onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
    h("section", { className: "cvs-prompt-modal", role: "dialog", "aria-modal": "true", "aria-label": "完整提示词" },
      h("header", { className: "cvs-prompt-modal-head" },
        h("div", null, h("strong", null, "完整提示词"), h("span", null, `${prompt.length} 字，${readOnly ? "AI 优化期间只读" : "可直接编辑"}`)),
        h("button", { type: "button", className: "cvs-close", title: "收起提示词", onClick: onClose }, "×")
      ),
      h("textarea", { className: "cvs-prompt-modal-textarea", readOnly, value: prompt, onChange: (event) => onChange(event.target.value), autoFocus: true }),
      h("footer", { className: "cvs-prompt-modal-foot" },
        h("span", null, readOnly ? "优化完成后会自动覆盖并恢复编辑" : "此处修改会同步到工作台提示词框"),
        h("button", { type: "button", className: "cvs-button cvs-button-primary", onClick: onClose }, readOnly ? "收起" : "保存并收起")
      )
    )
  );
}

function UploadCard({ title, hint, preview, busy, disabled, onUpload }) {
  return h("div", { className: "cvs-keyframe-item" },
    h("div", { className: "cvs-keyframe-label" }, h("strong", null, title), h("span", null, hint)),
    h("label", { className: "cvs-upload" },
      preview ? h("img", { src: preview, alt: `${title}预览` }) : null,
      preview ? h("span", { className: "cvs-upload-shade" }) : null,
      h("input", { type: "file", disabled, accept: "image/png,image/jpeg,image/webp", onChange: (event) => onUpload(event.target.files?.[0]) }),
      h("span", { className: "cvs-upload-copy" }, h("strong", null, busy ? "正在上传…" : preview ? "点击替换" : "上传图片"), h("span", null, "PNG / JPEG / WebP"))
    )
  );
}

function StudioOverlay({ useSessions, connection, sessions }) {
  const visible = useSyncExternalStore(visibility.subscribe.bind(visibility), visibility.getSnapshot.bind(visibility));
  const sessionId = useSessions((state) => state.current);
  const [mode, setMode] = useState("t2v");
  const [values, setValues] = useState(() => ({
    ...BASE_VALUES,
    outputDirectory: localStorage.getItem("dsh-comfy-video-studio/outputDirectory") || ""
  }));
  const [imagePreviews, setImagePreviews] = useState({});
  const previewUrls = useRef({});
  const [health, setHealth] = useState({ status: "idle", ok: false, missingNodes: [] });
  const [tasks, setTasks] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState("");
  const [optimization, setOptimization] = useState({ phase: "idle" });
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [promptTemplates, setPromptTemplates] = useState([]);
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [workflowCatalog, setWorkflowCatalog] = useState({ defaultId: "minimax-h3-default", presets: [], invalid: [] });
  const [connectionCatalog, setConnectionCatalog] = useState({ defaultId: "default", presets: [] });
  const [connectionDraft, setConnectionDraft] = useState({ ...EMPTY_CONNECTION_DRAFT });
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);
  const selected = tasks.find((task) => task.id === selectedId) || tasks[0] || null;

  const update = (key, value) => setValues((current) => ({ ...current, [key]: value }));
  const updateKeyframe = (ref, patch) => setValues((current) => ({
    ...current,
    keyframes: current.keyframes.map((item) => item.ref === ref ? { ...item, ...patch } : item)
  }));
  const notify = (message) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3600);
  };

  const refreshTasks = async () => {
    const next = await api("/tasks");
    setTasks(next);
    if (!selectedId && next[0]) setSelectedId(next[0].id);
  };

  const refreshTemplates = async () => {
    const next = await api("/templates");
    setPromptTemplates(next);
    return next;
  };

  const refreshWorkflows = async (force = false) => {
    if (force) await api("/workflows/refresh", { method: "POST" });
    const next = await api("/workflows");
    setWorkflowCatalog(next);
    setValues((current) => {
      const exists = next.presets.some((preset) => preset.id === current.workflowPresetId);
      return exists ? current : { ...current, workflowPresetId: next.defaultId };
    });
    return next;
  };

  const checkHealth = async (connectionPresetId) => {
    if (!connectionPresetId) return;
    setHealth((current) => ({ ...current, status: "loading", ok: false, error: null }));
    try {
      const value = await api(`/health?connectionPresetId=${encodeURIComponent(connectionPresetId)}`);
      setHealth({ status: "ready", ...value });
    } catch (error) {
      setHealth({ status: "error", ok: false, error: error.message, missingNodes: [] });
    }
  };

  const refreshConnections = async () => {
    const next = await api("/connections");
    setConnectionCatalog(next);
    const remembered = localStorage.getItem("dsh-comfy-video-studio/connectionPresetId");
    const currentId = values.connectionPresetId;
    const selectedId = next.presets.some((item) => item.id === currentId)
      ? currentId
      : next.presets.some((item) => item.id === remembered) ? remembered : next.defaultId;
    setValues((current) => ({ ...current, connectionPresetId: selectedId }));
    const selectedPreset = next.presets.find((item) => item.id === selectedId);
    if (selectedPreset) setConnectionDraft({ ...selectedPreset, makeDefault: next.defaultId === selectedId });
    localStorage.setItem("dsh-comfy-video-studio/connectionPresetId", selectedId);
    return selectedId;
  };

  const selectConnectionPreset = (connectionPresetId, suppliedPreset = null) => {
    if (!connectionPresetId || connectionPresetId === values.connectionPresetId) return;
    const selectedPreset = suppliedPreset || connectionCatalog.presets.find((item) => item.id === connectionPresetId);
    const hadImages = Boolean(values.image || values.keyframes.some((item) => item.image));
    for (const url of Object.values(previewUrls.current)) URL.revokeObjectURL(url);
    previewUrls.current = {};
    setImagePreviews({});
    setValues((current) => ({
      ...current,
      connectionPresetId,
      image: "",
      keyframes: current.keyframes.map((item) => ({ ...item, image: "" }))
    }));
    if (selectedPreset) setConnectionDraft({ ...selectedPreset, makeDefault: connectionCatalog.defaultId === connectionPresetId });
    localStorage.setItem("dsh-comfy-video-studio/connectionPresetId", connectionPresetId);
    void checkHealth(connectionPresetId);
    notify(hadImages ? "已切换 ComfyUI；图片属于原实例，请重新上传" : "已切换 ComfyUI 连接");
  };

  const testConnectionDraft = async () => {
    if (!connectionDraft.name.trim() || !connectionDraft.baseUrl.trim()) return notify("请填写连接名称和 ComfyUI 地址");
    setBusy("connection-test");
    try {
      const result = await api("/connections/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(connectionDraft)
      });
      notify(result.ok ? "连接测试通过，所需节点完整" : `连接成功，但缺少 ${result.missingNodes.length} 个节点`);
    } catch (error) {
      notify(`连接测试失败：${error.message}`);
    } finally {
      setBusy("");
    }
  };

  const saveConnectionDraft = async (updateExisting) => {
    if (!connectionDraft.name.trim() || !connectionDraft.baseUrl.trim()) return notify("请填写连接名称和 ComfyUI 地址");
    if (updateExisting && (!connectionDraft.id || !connectionDraft.mutable)) return notify("当前连接不能在页面修改");
    const previousPreset = connectionCatalog.presets.find((item) => item.id === connectionDraft.id);
    const activeTargetChanged = updateExisting
      && connectionDraft.id === values.connectionPresetId
      && (previousPreset?.baseUrl !== connectionDraft.baseUrl.trim() || previousPreset?.allowSelfSigned !== (connectionDraft.allowSelfSigned === true));
    setBusy("connection-save");
    try {
      const result = await api("/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(updateExisting ? { id: connectionDraft.id } : {}),
          name: connectionDraft.name.trim(),
          baseUrl: connectionDraft.baseUrl.trim(),
          allowSelfSigned: connectionDraft.allowSelfSigned === true,
          makeDefault: connectionDraft.makeDefault === true
        })
      });
      selectConnectionPreset(result.preset.id, result.preset);
      setConnectionCatalog(result.catalog);
      setConnectionDraft({ ...result.preset, makeDefault: result.catalog.defaultId === result.preset.id });
      if (activeTargetChanged) {
        for (const url of Object.values(previewUrls.current)) URL.revokeObjectURL(url);
        previewUrls.current = {};
        setImagePreviews({});
        setValues((current) => ({
          ...current,
          image: "",
          keyframes: current.keyframes.map((item) => ({ ...item, image: "" }))
        }));
      }
      if (result.preset.id === values.connectionPresetId) await checkHealth(result.preset.id);
      notify(activeTargetChanged ? "连接地址已更新；旧实例图片引用已清空" : updateExisting ? "连接预设已更新并立即生效" : "连接预设已保存并切换");
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy("");
    }
  };

  const deleteConnectionDraft = async () => {
    if (!connectionDraft.id || !connectionDraft.mutable) return notify("内置连接不能删除");
    if (!window.confirm(`删除连接预设“${connectionDraft.name}”？已创建任务仍保留实例快照。`)) return;
    setBusy("connection-delete");
    try {
      await api(`/connections/${encodeURIComponent(connectionDraft.id)}`, { method: "DELETE" });
      if (connectionDraft.id === values.connectionPresetId) {
        for (const url of Object.values(previewUrls.current)) URL.revokeObjectURL(url);
        previewUrls.current = {};
        setImagePreviews({});
        setValues((current) => ({
          ...current,
          image: "",
          keyframes: current.keyframes.map((item) => ({ ...item, image: "" }))
        }));
      }
      localStorage.removeItem("dsh-comfy-video-studio/connectionPresetId");
      const selectedId = await refreshConnections();
      await checkHealth(selectedId);
      notify("连接预设已删除");
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy("");
    }
  };

  useEffect(() => () => {
    clearTimeout(toastTimer.current);
    for (const url of Object.values(previewUrls.current)) URL.revokeObjectURL(url);
  }, []);

  useEffect(() => {
    if (!visible) return;
    refreshConnections().then(checkHealth, (error) => setHealth({ status: "error", ok: false, error: error.message, missingNodes: [] }));
    refreshTasks().catch((error) => notify(error.message));
    refreshTemplates().catch((error) => notify(error.message));
    refreshWorkflows().catch((error) => notify(error.message));
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => refreshTasks().catch(() => {}), 1200);
    return () => clearInterval(timer);
  }, [visible, selectedId]);

  useEffect(() => {
    setValues((current) => ({ ...current, duration: mode === "t2v" ? 5 : 10 }));
    setTemplateId("");
    setTemplateName("");
  }, [mode]);

  useEffect(() => {
    if (optimization.phase !== "waiting" || !optimization.token || !optimization.sessionId) return;
    const binding = sessions.binding(optimization.sessionId);
    const session = binding?.session;
    if (!session) {
      setOptimization((current) => ({ ...current, phase: "error", message: "澄清会话已不可用，请重新发起 AI 优化" }));
      return;
    }
    const inspect = () => {
      const prompt = clarifiedPrompt(session.getSnapshot(), optimization.token, optimization.afterSequence || 0);
      if (!prompt) return;
      setOptimization((current) => ({ ...current, phase: "finalizing", message: "正在把已确认的最终提示词覆盖回工作台" }));
      setValues((current) => ({ ...current, prompt }));
      setOptimization((current) => ({
        ...current,
        phase: "completed",
        message: "对话中的确认结果已自动同步，可以检查后生成视频。",
        optimizedPrompt: prompt
      }));
      visibility.set(true);
    };
    const unsubscribe = session.subscribe(inspect);
    inspect();
    return unsubscribe;
  }, [optimization.phase, optimization.token, optimization.sessionId, optimization.afterSequence, sessions]);

  if (!visible) return null;

  const addKeyframe = () => {
    if (values.keyframes.length >= 3) return;
    const ref = `K${values.keyframes.length + 1}`;
    const defaults = [0, Math.max(.1, values.duration / 2), Math.max(.2, values.duration * .8)];
    setValues((current) => ({
      ...current,
      keyframes: [...current.keyframes, { ref, image: "", timeSeconds: Number(defaults[current.keyframes.length].toFixed(2)) }]
    }));
  };

  const removeKeyframe = (ref) => {
    if (values.keyframes.length <= 1) return notify("关键帧模式至少保留一张图片");
    const previewKey = `keyframe-${ref}`;
    if (previewUrls.current[previewKey]) URL.revokeObjectURL(previewUrls.current[previewKey]);
    delete previewUrls.current[previewKey];
    setImagePreviews((current) => { const next = { ...current }; delete next[previewKey]; return next; });
    setValues((current) => ({
      ...current,
      keyframes: current.keyframes.filter((item) => item.ref !== ref).map((item, index) => ({ ...item, ref: `K${index + 1}` }))
    }));
  };

  const validateKeyframes = () => {
    if (mode !== "keyframe") return true;
    if (values.keyframes.some((item) => !item.image)) return notify("请为每个关键帧上传图片");
    if (values.keyframes.some((item) => !Number.isFinite(Number(item.timeSeconds)) || Number(item.timeSeconds) < 0 || Number(item.timeSeconds) >= values.duration)) {
      return notify(`关键帧时间必须在 0（含）到 ${values.duration} 秒（不含）之间`);
    }
    const frames = values.keyframes.map((item) => Math.round(Number(item.timeSeconds) * 24));
    if (new Set(frames).size !== frames.length) return notify("两个关键帧取整后落在同一帧，请至少错开 1/24 秒");
    return true;
  };

  const optimize = async () => {
    if (!sessionId) return notify("请先在 Harness 中打开一个会话");
    if (!values.prompt.trim()) return notify("请先输入提示词");
    if (mode === "i2v" && !values.image) return notify("图生视频请先上传参考图");
    if (!validateKeyframes()) return;
    const originalPrompt = values.prompt.trim();
    setOptimization({ phase: "resolving-model", message: "正在确认本会话实际选中的 provider 和 model", originalPrompt });
    try {
      const answer = await connection.api.sessions.models({ sessionId });
      if (!answer.result.ok) throw new Error(answer.result.error.message);
      const current = answer.result.value.current;
      const modelLabel = `${current.provider}/${current.model}`;
      setOptimization({ phase: "analyzing", message: "模型正在判断是否存在会改变成片结果的歧义，并组织镜头、动作和时序", originalPrompt, model: modelLabel });
      const result = await api("/optimize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          provider: current.provider,
          model: current.model,
          mode,
          prompt: originalPrompt,
          image: values.image,
          keyframes: values.keyframes,
          duration: values.duration,
          resolutionPreset: values.resolutionPreset,
          workflowPresetId: values.workflowPresetId
        })
      });
      if (result.decision === "clarify") {
        const binding = sessions.binding(sessionId);
        if (!binding?.session) throw new Error("无法打开当前会话进行澄清");
        const token = crypto.randomUUID();
        const snapshot = binding.session.getSnapshot();
        const afterSequence = latestSequence(snapshot);
        setOptimization({
          phase: "handoff",
          message: result.reason || "关键信息需要你确认",
          questions: result.questions,
          originalPrompt,
          model: modelLabel,
          token,
          sessionId,
          afterSequence
        });
        const admission = await binding.session.prompt([{
          type: "text",
          text: clarificationInstruction({
            token,
            mode,
            prompt: originalPrompt,
            questions: result.questions,
            duration: values.duration,
            aspectRatio: RESOLUTIONS[values.resolutionPreset]?.label || RESOLUTIONS.balanced.label,
            keyframes: values.keyframes
          })
        }], "queue");
        if (!admission.ok) throw new Error(admission.error?.message || "澄清问题发送失败");
        setOptimization((value) => ({ ...value, phase: "waiting", message: "已切换到当前对话。请回答模型的问题；确认完成后会自动返回工作台。" }));
        visibility.set(false);
        return;
      }
      update("prompt", result.prompt);
      setOptimization({
        phase: "completed",
        message: result.summary || "提示词已按视频生成规范完成改写。",
        originalPrompt,
        optimizedPrompt: result.prompt,
        model: modelLabel
      });
      notify(`已使用 ${result.provider}/${result.model} 覆盖提示词`);
    } catch (error) {
      setOptimization((current) => ({ ...current, phase: "error", message: error.message }));
      notify(error.message);
    }
  };

  const cancelOptimization = () => {
    setOptimization({ phase: "idle" });
    notify("已取消本次 AI 优化等待；对话中已经发出的消息不会撤回");
  };

  const applyPromptTemplate = () => {
    const selectedTemplate = promptTemplates.find((item) => item.id === templateId && item.mode === mode);
    if (!selectedTemplate) return notify("请先选择一个自定义模板");
    update("prompt", selectedTemplate.prompt);
    setOptimization({ phase: "idle" });
    setTemplateName(selectedTemplate.name);
    notify(`已套用“${selectedTemplate.name}”`);
  };

  const saveCustomTemplate = async (updateExisting) => {
    if (!templateName.trim()) return notify("请填写模板名称");
    if (!values.prompt.trim()) return notify("当前提示词为空，不能保存模板");
    if (updateExisting && !templateId) return notify("请先选择要更新的模板");
    setBusy("template");
    try {
      const saved = await api("/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: updateExisting ? templateId : undefined, name: templateName.trim(), prompt: values.prompt.trim(), mode })
      });
      await refreshTemplates();
      setTemplateId(saved.id);
      setTemplateName(saved.name);
      notify(updateExisting ? "自定义模板已更新" : "自定义模板已保存");
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy("");
    }
  };

  const deleteCustomTemplate = async () => {
    const selectedTemplate = promptTemplates.find((item) => item.id === templateId);
    if (!selectedTemplate) return notify("请先选择要删除的模板");
    if (!window.confirm(`删除自定义模板“${selectedTemplate.name}”？`)) return;
    setBusy("template");
    try {
      await api(`/templates/${encodeURIComponent(templateId)}`, { method: "DELETE" });
      await refreshTemplates();
      setTemplateId("");
      setTemplateName("");
      notify("自定义模板已删除");
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy("");
    }
  };

  const uploadImage = async (file, valueKey = "image") => {
    if (!file) return;
    setBusy(`upload-${valueKey}`);
    try {
      const result = await api(`/upload?connectionPresetId=${encodeURIComponent(values.connectionPresetId)}`, {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
        body: file
      });
      if (previewUrls.current[valueKey]) URL.revokeObjectURL(previewUrls.current[valueKey]);
      const preview = URL.createObjectURL(file);
      previewUrls.current[valueKey] = preview;
      setImagePreviews((current) => ({ ...current, [valueKey]: preview }));
      const uploaded = result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
      if (valueKey.startsWith("keyframe-")) {
        const ref = valueKey.slice("keyframe-".length);
        updateKeyframe(ref, { image: uploaded });
        notify(`关键帧 @${ref} 已上传`);
      } else {
        update(valueKey, uploaded);
        notify("参考图已上传到 ComfyUI");
      }
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy("");
    }
  };

  const generate = async () => {
    if (!values.outputDirectory.trim()) return notify("请填写远程主机上的绝对输出目录");
    if (mode === "i2v" && !values.image) return notify("图生视频请先上传参考图");
    if (!validateKeyframes()) return;
    setBusy("generate");
    try {
      localStorage.setItem("dsh-comfy-video-studio/outputDirectory", values.outputDirectory);
      const task = await api("/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, connectionPresetId: values.connectionPresetId, workflowPresetId: values.workflowPresetId, values })
      });
      setSelectedId(task.id);
      await refreshTasks();
      notify("工作流已提交到 ComfyUI");
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy("");
    }
  };

  const cancel = async () => {
    if (!selected) return;
    try {
      await api(`/tasks/${encodeURIComponent(selected.id)}/cancel`, { method: "POST" });
      await refreshTasks();
    } catch (error) {
      notify(error.message);
    }
  };

  const clearFinishedHistory = async () => {
    if (!window.confirm("只清除已完成、失败和取消的历史记录，不删除已输出的视频文件。继续吗？")) return;
    try {
      const result = await api("/tasks", { method: "DELETE" });
      setSelectedId(null);
      await refreshTasks();
      notify(`已清除 ${result.removed} 条历史记录，视频文件未删除`);
    } catch (error) {
      notify(error.message);
    }
  };

  const randomSeed = () => update("seed", Math.floor(Math.random() * 9007199254740990));
  const running = selected && !["completed", "failed", "cancelled"].includes(selected.status);
  const optimizationLocked = OPTIMIZATION_ACTIVE.has(optimization.phase);
  const modeTemplates = promptTemplates.filter((item) => item.mode === mode);
  const selectedPromptTemplate = modeTemplates.find((item) => item.id === templateId) || null;
  const compatibleWorkflows = workflowCatalog.presets.filter((preset) => preset.modes.includes(mode));
  const selectedResolution = RESOLUTIONS[values.resolutionPreset] || RESOLUTIONS.balanced;
  const keyframeTimeline = [...values.keyframes]
    .sort((a, b) => Number(a.timeSeconds) - Number(b.timeSeconds))
    .map((item) => `@${item.ref} ${Number(item.timeSeconds).toFixed(2)}s`)
    .join(" → ");

  return h("div", { className: "cvs-shell", role: "dialog", "aria-modal": "true", "aria-label": "Comfy 视频工作台" },
    h("header", { className: "cvs-topbar" },
      h("div", { className: "cvs-brand" },
        h("div", { className: "cvs-brand-mark" }, h(VideoIcon, { size: 21 })),
        h("div", null, h("div", { className: "cvs-brand-title" }, "COMFY VIDEO STUDIO"), h("div", { className: "cvs-brand-sub" }, "MiniMax H3 · DeepSeek Harness"))
      ),
      h("div", { className: "cvs-mode-tabs", role: "tablist" },
        h("button", { className: "cvs-mode-tab", role: "tab", disabled: optimizationLocked, "aria-selected": mode === "t2v", onClick: () => setMode("t2v") }, "文生视频"),
        h("button", { className: "cvs-mode-tab", role: "tab", disabled: optimizationLocked, "aria-selected": mode === "i2v", onClick: () => setMode("i2v") }, "图生视频"),
        h("button", { className: "cvs-mode-tab", role: "tab", disabled: optimizationLocked, "aria-selected": mode === "keyframe", onClick: () => setMode("keyframe") }, "关键帧")
      ),
      h("div", { className: "cvs-top-spacer" }),
      h("div", { className: "cvs-connection", title: health.error || health.connection?.baseUrl || (health.missingNodes?.length ? `缺少：${health.missingNodes.join(", ")}` : "") },
        h("span", { className: "cvs-dot", "data-ok": health.ok ? "true" : "false" }),
        health.status === "loading" ? "检测 ComfyUI" : health.ok ? `${health.connection?.name || "ComfyUI"} 已连接` : health.error ? "ComfyUI 不可用" : "节点不完整"
      ),
      h("button", { type: "button", className: "cvs-close", title: "返回 Harness", onClick: () => visibility.set(false) }, "×")
    ),
    h("main", { className: "cvs-main" },
      h("aside", { className: "cvs-panel cvs-panel-left" },
        mode === "i2v" ? h("section", { className: "cvs-section" },
          h("h2", { className: "cvs-section-title" }, "参考图"),
          h(UploadCard, { title: "参考图", hint: "首帧静态事实", preview: imagePreviews.image, busy: busy === "upload-image", disabled: optimizationLocked || !health.ok, onUpload: (file) => uploadImage(file, "image") })
        ) : null,
        mode === "keyframe" ? h("section", { className: "cvs-section" },
          h("div", { className: "cvs-section-heading" },
            h("h2", { className: "cvs-section-title" }, "关键帧图片"),
            h("button", { type: "button", className: "cvs-text-button", disabled: values.keyframes.length >= 3 || optimizationLocked, onClick: addKeyframe }, "+ 添加关键帧")
          ),
          h("div", { className: "cvs-keyframe-note" }, `时间线：${keyframeTimeline || "尚未设置"}；可引用 @K1、@K2、@K3`),
          h("div", { className: "cvs-keyframe-grid" },
            values.keyframes.map((item, index) => h("div", { className: "cvs-keyframe-card", key: item.ref },
              h(UploadCard, {
                title: `@${item.ref}`,
                hint: `${Math.round(Number(item.timeSeconds) * 24)} 帧`,
                preview: imagePreviews[`keyframe-${item.ref}`],
                busy: busy === `upload-keyframe-${item.ref}`,
                disabled: optimizationLocked || !health.ok,
                onUpload: (file) => uploadImage(file, `keyframe-${item.ref}`)
              }),
              h(Field, { label: "出现时间", valueLabel: `${Number(item.timeSeconds).toFixed(2)}s` }, h(NumberInput, {
                value: item.timeSeconds, min: 0, max: Math.max(0, values.duration - 1 / 24), step: .01,
                onChange: (timeSeconds) => updateKeyframe(item.ref, { timeSeconds })
              })),
              values.keyframes.length > 1 && index === values.keyframes.length - 1
                ? h("button", { type: "button", className: "cvs-mini-button cvs-remove-keyframe", disabled: optimizationLocked, onClick: () => removeKeyframe(item.ref) }, "移除")
                : null
            ))
          )
        ) : null,
        h("section", { className: "cvs-section" },
          h("div", { className: "cvs-section-heading" },
            h("h2", { className: "cvs-section-title" }, "创作描述"),
            h("button", { type: "button", className: "cvs-text-button", onClick: () => setPromptExpanded(true) }, "展开查看")
          ),
          h("div", { className: "cvs-template-row" },
            h("select", { className: "cvs-select", value: templateId, disabled: optimizationLocked, onChange: (event) => { const id = event.target.value; setTemplateId(id); setTemplateName(modeTemplates.find((item) => item.id === id)?.name || ""); }, "aria-label": "提示词模板" },
              h("option", { value: "" }, modeTemplates.length ? "选择自定义模板" : "暂无自定义模板"),
              modeTemplates.map((item) => h("option", { key: item.id, value: item.id }, item.name))
            ),
            h("button", { type: "button", className: "cvs-button", disabled: optimizationLocked || !selectedPromptTemplate, onClick: applyPromptTemplate }, "套用")
          ),
          h("details", { className: "cvs-template-manager" },
            h("summary", null, "管理自定义模板"),
            h(Input, { value: templateName, disabled: optimizationLocked, placeholder: "模板名称", onChange: setTemplateName }),
            h("div", { className: "cvs-template-actions" },
              h("button", { type: "button", className: "cvs-button", disabled: optimizationLocked || busy === "template", onClick: () => saveCustomTemplate(false) }, "保存为新模板"),
              h("button", { type: "button", className: "cvs-button", disabled: optimizationLocked || busy === "template" || !templateId, onClick: () => saveCustomTemplate(true) }, "更新所选"),
              h("button", { type: "button", className: "cvs-button cvs-button-danger", disabled: optimizationLocked || busy === "template" || !templateId, onClick: deleteCustomTemplate }, "删除")
            )
          ),
          h(Field, { label: "提示词", valueLabel: `${values.prompt.length} 字` }, h("textarea", { className: "cvs-textarea", readOnly: optimizationLocked, value: values.prompt, placeholder: mode === "keyframe" ? "用 @K1、@K2、@K3 引用图片，并描述它们之间的连续运动…" : mode === "i2v" ? "描述参考图中的主体如何运动、镜头如何运动，以及场景变化…" : "描述主体、场景、动作、镜头和时间节奏…", onChange: (event) => update("prompt", event.target.value) })),
          h(OptimizationStatus, { value: optimization, onShowPrompt: () => setPromptExpanded(true), onCancel: cancelOptimization }),
          h("div", { className: "cvs-actions" },
            h("button", { className: "cvs-button", disabled: !!busy || optimizationLocked, onClick: optimize }, h("span", { className: "cvs-inline" }, h(SparkIcon, { size: 17 }), optimizationLocked ? "AI 优化中" : "AI 优化")),
            h("button", { className: "cvs-button cvs-button-primary", title: optimizationLocked ? "提示词优化完成前不能生成视频" : "生成视频", disabled: !!busy || !health.ok || optimizationLocked, onClick: generate }, busy === "generate" ? "正在提交" : optimizationLocked ? "等待提示词优化" : "生成视频")
          )
        ),
        h("section", { className: "cvs-section" },
          h("h2", { className: "cvs-section-title" }, "画面与时长"),
          h(Field, { label: "ComfyUI 连接", valueLabel: health.status === "loading" ? "检测中" : health.ok ? "可用" : "不可用" }, h("select", {
            className: "cvs-select",
            value: values.connectionPresetId,
            disabled: Boolean(busy),
            onChange: (event) => selectConnectionPreset(event.target.value)
          }, connectionCatalog.presets.map((item) => h("option", { key: item.id, value: item.id }, `${item.name} · ${item.id}`)))),
          h("div", { className: "cvs-resolution-help" }, health.connection?.baseUrl || "在下方管理连接地址"),
          h("details", { className: "cvs-template-manager" },
            h("summary", null, "管理 ComfyUI 连接"),
            h(Field, { label: "连接名称" }, h(Input, {
              value: connectionDraft.name,
              placeholder: "例如：远程机 ComfyUI",
              onChange: (name) => setConnectionDraft((current) => ({ ...current, name }))
            })),
            h(Field, { label: "ComfyUI 地址" }, h(Input, {
              type: "url",
              value: connectionDraft.baseUrl,
              placeholder: "https://example.com:8188",
              onChange: (baseUrl) => setConnectionDraft((current) => ({ ...current, baseUrl }))
            })),
            h("label", { className: "cvs-inline" },
              h("input", {
                type: "checkbox",
                checked: connectionDraft.allowSelfSigned === true,
                onChange: (event) => setConnectionDraft((current) => ({ ...current, allowSelfSigned: event.target.checked }))
              }),
              "允许自签名 HTTPS 证书"
            ),
            h("label", { className: "cvs-inline" },
              h("input", {
                type: "checkbox",
                checked: connectionDraft.makeDefault === true,
                onChange: (event) => setConnectionDraft((current) => ({ ...current, makeDefault: event.target.checked }))
              }),
              "设为默认连接"
            ),
            h("div", { className: "cvs-template-actions" },
              h("button", { type: "button", className: "cvs-button", disabled: Boolean(busy), onClick: testConnectionDraft }, busy === "connection-test" ? "测试中" : "测试连接"),
              h("button", { type: "button", className: "cvs-button", disabled: Boolean(busy), onClick: () => saveConnectionDraft(false) }, "保存为新连接"),
              h("button", { type: "button", className: "cvs-button", disabled: Boolean(busy) || !connectionDraft.mutable || !connectionDraft.id, onClick: () => saveConnectionDraft(true) }, "更新所选"),
              h("button", { type: "button", className: "cvs-button", disabled: Boolean(busy), onClick: () => setConnectionDraft({ ...EMPTY_CONNECTION_DRAFT }) }, "清空表单"),
              h("button", { type: "button", className: "cvs-button cvs-button-danger", disabled: Boolean(busy) || !connectionDraft.mutable || !connectionDraft.id, onClick: deleteConnectionDraft }, "删除")
            ),
            h("div", { className: "cvs-resolution-help" }, "地址在插件运行期间保存并立即生效；切换实例后需要重新上传参考图。")
          ),
          h(Field, { label: "输出目录" }, h(Input, { value: values.outputDirectory, placeholder: "例如 D:\\Videos\\MiniMax", onChange: (value) => update("outputDirectory", value) })),
          h(Field, { label: "工作流预设" }, h("div", { className: "cvs-workflow-row" },
            h("select", { className: "cvs-select", value: compatibleWorkflows.some((item) => item.id === values.workflowPresetId) ? values.workflowPresetId : "", onChange: (event) => update("workflowPresetId", event.target.value) },
              h("option", { value: "" }, "选择已验证预设"),
              compatibleWorkflows.map((item) => h("option", { key: item.id, value: item.id }, `${item.name} · ${item.id}`))
            ),
            h("button", { type: "button", className: "cvs-icon-button", title: "刷新自定义工作流目录", onClick: () => refreshWorkflows(true).then(() => notify("工作流预设已刷新"), (error) => notify(error.message)) }, "↻")
          )),
          h(Field, { label: "手动输入预设 ID", valueLabel: workflowCatalog.invalid.length ? `${workflowCatalog.invalid.length} 个预设无效` : null }, h(Input, { value: values.workflowPresetId, onChange: (value) => update("workflowPresetId", value.trim()) })),
          h(Field, { label: "竖屏分辨率", valueLabel: `${selectedResolution.width}×${selectedResolution.height}` }, h("select", { className: "cvs-select", value: values.resolutionPreset, onChange: (event) => update("resolutionPreset", event.target.value) },
            Object.entries(RESOLUTIONS).map(([id, item]) => h("option", { key: id, value: id }, item.label))
          )),
          h("div", { className: "cvs-resolution-help" }, selectedResolution.label),
          h("div", { className: "cvs-grid-2" },
            h(Field, { label: "时长", valueLabel: `${values.duration}s` }, h(NumberInput, { value: values.duration, min: 1, max: 60, step: .1, onChange: (value) => update("duration", value) })),
            h(Field, { label: "生成帧率", valueLabel: "固定 24 FPS" }, h(Input, { value: "24", readOnly: true }))
          )
        ),
        h("section", { className: "cvs-section" },
          h("details", { className: "cvs-advanced" },
            h("summary", null, h("span", null, "高级参数"), h("span", null, "＋")),
            h("div", { className: "cvs-grid-2" },
              h(Field, { label: "Steps" }, h(NumberInput, { value: values.steps, min: 1, max: 200, onChange: (value) => update("steps", value) })),
              h(Field, { label: "Denoise" }, h(NumberInput, { value: values.denoise, min: 0, max: 1, step: .05, onChange: (value) => update("denoise", value) })),
              h(Field, { label: "Scheduler" }, h(Input, { value: values.scheduler, onChange: (value) => update("scheduler", value) })),
              h(Field, { label: "Sampler" }, h(Input, { value: values.sampler, onChange: (value) => update("sampler", value) })),
              h(Field, { label: "Bit depth" }, h(NumberInput, { value: values.bitDepth, min: 8, max: 16, onChange: (value) => update("bitDepth", value) })),
              h(Field, { label: "格式" }, h(Select, { value: values.format, onChange: (value) => update("format", value), options: ["mp4", "webm", "mkv", "auto"] }))
            ),
            h(Field, { label: "Seed" }, h("div", { className: "cvs-inline" }, h(Input, { type: "number", value: values.seed, onChange: (value) => update("seed", Number(value)) }), h("button", { className: "cvs-icon-button", type: "button", title: "随机 Seed", onClick: randomSeed }, "↻"))),
            h(Field, { label: "Codec" }, h(Input, { value: values.codec, onChange: (value) => update("codec", value) })),
            h(Field, { label: "UNet" }, h(Input, { value: values.unetName, onChange: (value) => update("unetName", value) })),
            h(Field, { label: "Weight dtype" }, h(Input, { value: values.weightDtype, onChange: (value) => update("weightDtype", value) })),
            h(Field, { label: "CLIP" }, h(Input, { value: values.clipName, onChange: (value) => update("clipName", value) })),
            h(Field, { label: "CLIP device" }, h(Input, { value: values.clipDevice, onChange: (value) => update("clipDevice", value) })),
            h(Field, { label: "Video VAE" }, h(Input, { value: values.videoVae, onChange: (value) => update("videoVae", value) })),
            h(Field, { label: "Audio VAE" }, h(Input, { value: values.audioVae, onChange: (value) => update("audioVae", value) }))
          )
        )
      ),
      h("section", { className: "cvs-stage" },
        h("div", { className: "cvs-viewer" },
          selected?.videoUrl ? h("video", { key: selected.videoUrl, src: selected.videoUrl, controls: true, playsInline: true }) : h("div", { className: "cvs-empty" },
            h("div", { className: "cvs-empty-ring" }, h(VideoIcon, { size: 34 })),
            h("div", null, h("strong", null, selected ? "视频正在制作中" : "准备创作第一支视频"), h("div", null, selected ? "生成完成并写入指定目录后，会在这里自动出现。" : "填写提示词和参数，然后提交到本机 ComfyUI。"))
          )
        ),
        h(Progress, { task: selected }),
        running ? h("button", { className: "cvs-button cvs-button-danger", onClick: cancel }, "取消当前任务") : null
      ),
      h("aside", { className: "cvs-panel cvs-panel-right" },
        h("section", { className: "cvs-section" }, h("div", { className: "cvs-section-heading" },
          h("h2", { className: "cvs-section-title" }, "制作记录"),
          tasks.some((task) => ["completed", "failed", "cancelled"].includes(task.status)) ? h("button", { type: "button", className: "cvs-text-button", onClick: clearFinishedHistory }, "清空已结束") : null
        ),
          h("div", { className: "cvs-task-list" }, tasks.length ? tasks.map((task) => h(TaskCard, { key: task.id, task, active: selected?.id === task.id, onClick: () => setSelectedId(task.id) })) : h("div", { className: "cvs-empty" }, "暂无任务"))
        )
      )
    ),
    promptExpanded ? h(PromptModal, { prompt: values.prompt, readOnly: optimizationLocked, onChange: (value) => update("prompt", value), onClose: () => setPromptExpanded(false) }) : null,
    toast ? h("div", { className: "cvs-toast", role: "status" }, toast) : null
  );
}

const inject = ["slots", "connection", "sessions"];

function installStyles(ctx) {
  ctx.effect(() => {
    const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`);
    existing?.remove();
    const tag = document.createElement("style");
    tag.dataset.pluginCss = STYLE_ID;
    tag.textContent = STUDIO_CSS;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, `${PACKAGE_ID}: studio styles`);
}

function apply(ctx) {
  installStyles(ctx);
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "comfy-video-studio",
    order: 45,
    label: "视频工作台"
  }, StudioButton));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: "comfy-video-studio",
    order: 900
  }, (props) => h(StudioOverlay, { ...props, connection: ctx.get("connection"), sessions: ctx.sessions })));
}
