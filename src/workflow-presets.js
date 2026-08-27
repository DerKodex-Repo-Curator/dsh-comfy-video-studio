import { access, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export const DEFAULT_WORKFLOW_PRESET_ID = "minimax-h3-default";
export const GENERATION_FPS = 24;
export const RESOLUTION_PRESETS = Object.freeze({
  balanced: Object.freeze({ id: "balanced", label: "576×1024（显存均衡）", width: 576, height: 1024 }),
  quality: Object.freeze({ id: "quality", label: "768×1344（高清，近似 9:16）", width: 768, height: 1344 })
});

const MODE_REQUIRED_BINDINGS = Object.freeze({
  t2v: ["prompt", "width", "height", "duration", "fps", "bitDepth", "steps", "denoise", "scheduler", "sampler", "seed", "unetName", "weightDtype", "clipName", "clipDevice", "videoVae", "audioVae", "sliceDuration", "sliceStrict", "format", "codec", "prefix"],
  i2v: ["prompt", "width", "height", "duration", "fps", "bitDepth", "steps", "denoise", "scheduler", "sampler", "seed", "unetName", "weightDtype", "clipName", "clipDevice", "videoVae", "audioVae", "sliceDuration", "sliceStrict", "format", "codec", "prefix", "image"],
  keyframe: ["prompt", "width", "height", "length", "fps", "bitDepth", "steps", "denoise", "scheduler", "sampler", "seed", "unetName", "weightDtype", "clipName", "clipDevice", "videoVae", "audioVae", "sliceDuration", "sliceStrict", "format", "codec", "prefix", "images", "guides"]
});

function finiteNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function integer(value, fallback, min, max) {
  return Math.round(finiteNumber(value, fallback, min, max));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function containedPath(base, candidate) {
  const absoluteBase = resolve(base);
  const absoluteCandidate = resolve(base, candidate);
  const rel = relative(absoluteBase, absoluteCandidate);
  if (rel === "" || (!rel.startsWith("..") && !rel.includes(":") && !rel.startsWith("/"))) return absoluteCandidate;
  throw new Error(`工作流路径越出预设目录：${candidate}`);
}

function bindingList(binding) {
  if (Array.isArray(binding)) return binding.flatMap(bindingList);
  return binding && typeof binding === "object" && typeof binding.node === "string" && typeof binding.input === "string" ? [binding] : [];
}

function validateBinding(workflow, binding, label) {
  const items = bindingList(binding);
  if (items.length === 0) throw new Error(`缺少有效语义绑定：${label}`);
  for (const item of items) {
    const node = workflow[item.node];
    if (!node || typeof node !== "object") throw new Error(`${label} 指向不存在的节点 ${item.node}`);
    if (!node.inputs || !Object.hasOwn(node.inputs, item.input)) throw new Error(`${label} 指向不存在的输入 ${item.node}.${item.input}`);
  }
}

async function loadModeEntry(base, mode, raw, label, expectedKeyframes = null) {
  if (!raw || typeof raw !== "object") throw new Error(`${label} 配置无效`);
  const apiPath = containedPath(base, String(raw.api || ""));
  const canvasPath = containedPath(base, String(raw.canvas || ""));
  const workflow = JSON.parse(await readFile(apiPath, "utf8"));
  await access(canvasPath);
  if (!workflow || Array.isArray(workflow) || typeof workflow !== "object") throw new Error(`${label} API JSON 格式无效`);
  const required = MODE_REQUIRED_BINDINGS[mode];
  for (const key of required) validateBinding(workflow, raw.bindings?.[key], `${label}.${key}`);
  if (expectedKeyframes != null) {
    if (raw.bindings.images.length !== expectedKeyframes || raw.bindings.guides.length !== expectedKeyframes) {
      throw new Error(`${label} 必须提供 ${expectedKeyframes} 组图片和时间绑定`);
    }
  }
  return { apiPath, canvasPath, workflow, bindings: clone(raw.bindings) };
}

async function loadPresetManifest(filename, source) {
  const base = dirname(filename);
  const raw = JSON.parse(await readFile(filename, "utf8"));
  const id = String(raw.id || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(id)) throw new Error("预设 ID 只能包含字母、数字、点、下划线和连字符，长度 3-64");
  const name = String(raw.name || "").trim();
  if (!name) throw new Error("预设名称不能为空");
  if (Number(raw.schemaVersion) !== 1) throw new Error(`不支持的预设 schemaVersion：${raw.schemaVersion}`);
  const modes = {};
  if (raw.modes?.t2v) modes.t2v = await loadModeEntry(base, "t2v", raw.modes.t2v, `${id}.t2v`);
  if (raw.modes?.i2v) modes.i2v = await loadModeEntry(base, "i2v", raw.modes.i2v, `${id}.i2v`);
  if (raw.modes?.keyframe) {
    const variants = {};
    for (const count of [1, 2, 3]) {
      const entry = raw.modes.keyframe.variants?.[count];
      if (!entry) throw new Error(`${id}.keyframe 缺少 ${count} 帧变体`);
      variants[count] = await loadModeEntry(base, "keyframe", entry, `${id}.keyframe.${count}`, count);
    }
    modes.keyframe = { variants };
  }
  if (Object.keys(modes).length === 0) throw new Error("预设没有可用模式");
  return {
    id,
    name: name.slice(0, 120),
    description: String(raw.description || "").trim().slice(0, 500),
    source,
    manifestPath: filename,
    modes
  };
}

function publicPreset(preset) {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    source: preset.source,
    modes: Object.keys(preset.modes)
  };
}

export function createWorkflowRegistry({ builtInManifest, customDirectory, logger }) {
  let presets = new Map();
  let invalid = [];

  async function refresh() {
    const next = new Map();
    const errors = [];
    const manifests = [{ filename: resolve(builtInManifest), source: "built-in" }];
    if (customDirectory) {
      try {
        const entries = await readdir(resolve(customDirectory), { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith(".preset.json")) manifests.push({ filename: resolve(customDirectory, entry.name), source: "custom" });
        }
      } catch (error) {
        if (error?.code !== "ENOENT") errors.push({ file: resolve(customDirectory), error: error.message });
      }
    }
    for (const item of manifests) {
      try {
        const preset = await loadPresetManifest(item.filename, item.source);
        if (next.has(preset.id)) throw new Error(`预设 ID 重复：${preset.id}`);
        next.set(preset.id, preset);
      } catch (error) {
        errors.push({ file: item.filename, error: error.message });
      }
    }
    if (!next.has(DEFAULT_WORKFLOW_PRESET_ID)) throw new Error(`内置工作流预设加载失败：${errors.map((item) => item.error).join("；")}`);
    presets = next;
    invalid = errors;
    for (const item of errors) logger?.warn?.(`[dsh-comfy-video-studio] workflow preset rejected: ${item.file}: ${item.error}`);
    return list();
  }

  function list() {
    return {
      defaultId: DEFAULT_WORKFLOW_PRESET_ID,
      presets: [...presets.values()].map(publicPreset).sort((a, b) => a.name.localeCompare(b.name)),
      invalid: clone(invalid)
    };
  }

  function get(id, mode, keyframeCount = null) {
    const normalizedId = String(id || DEFAULT_WORKFLOW_PRESET_ID).trim();
    const preset = presets.get(normalizedId);
    if (!preset) throw new Error(`工作流预设不存在或未通过验证：${normalizedId}`);
    const modeEntry = preset.modes[mode];
    if (!modeEntry) throw new Error(`工作流预设 ${normalizedId} 不支持模式 ${mode}`);
    const entry = mode === "keyframe" ? modeEntry.variants[keyframeCount] : modeEntry;
    if (!entry) throw new Error(`工作流预设 ${normalizedId} 不支持 ${keyframeCount} 个关键帧`);
    return { preset, entry };
  }

  return { refresh, list, get };
}

export function frameCountForDuration(duration) {
  const requested = Math.max(5, Math.round(finiteNumber(duration, 10, 1, 60) * GENERATION_FPS));
  return requested + ((5 - (requested % 17) + 17) % 17);
}

export function normalizeKeyframes(values) {
  const duration = finiteNumber(values?.duration ?? values?.sliceDuration, 10, 1, 60);
  let raw = Array.isArray(values?.keyframes) ? values.keyframes : null;
  if (!raw && values?.keyframeA && values?.keyframeB && values?.keyframeC) {
    const legacyFps = finiteNumber(values.fps, GENERATION_FPS, 1, 120);
    raw = [
      { ref: "K1", image: values.keyframeA, timeSeconds: 0 },
      { ref: "K2", image: values.keyframeB, timeSeconds: finiteNumber(values.keyframeIndexB, 120, 0, 4096) / legacyFps },
      { ref: "K3", image: values.keyframeC, timeSeconds: finiteNumber(values.keyframeIndexC, 216, 0, 4096) / legacyFps }
    ];
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) throw new Error("关键帧模式需要 1-3 个关键帧");
  const usedRefs = new Set();
  const totalFrames = frameCountForDuration(duration);
  const normalized = raw.map((item, index) => {
    const requestedRef = String(item?.ref || `K${index + 1}`).replace(/^@/, "").toUpperCase();
    const ref = /^K[1-3]$/.test(requestedRef) ? requestedRef : `K${index + 1}`;
    if (usedRefs.has(ref)) throw new Error(`关键帧引用重复：@${ref}`);
    usedRefs.add(ref);
    const image = String(item?.image || "").trim();
    if (!image) throw new Error(`@K${index + 1} 尚未上传图片`);
    const timeSeconds = Number(item?.timeSeconds);
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds >= duration) throw new Error(`@K${index + 1} 时间必须在 0（含）到 ${duration} 秒（不含）之间`);
    const frameIndex = Math.round(timeSeconds * GENERATION_FPS);
    if (frameIndex >= totalFrames) throw new Error(`@${ref} 取整后超出总帧数 ${totalFrames}`);
    return { ref, image, timeSeconds, frameIndex };
  });
  const frames = new Set();
  for (const item of normalized) {
    if (frames.has(item.frameIndex)) throw new Error(`关键帧时间取整后重复在第 ${item.frameIndex} 帧，请至少错开 1/24 秒`);
    frames.add(item.frameIndex);
  }
  return normalized.sort((a, b) => a.frameIndex - b.frameIndex);
}

function setBinding(workflow, binding, value, label) {
  const node = workflow[binding.node];
  if (!node?.inputs || !Object.hasOwn(node.inputs, binding.input)) throw new Error(`工作流绑定失效：${label}`);
  node.inputs[binding.input] = value;
}

export function configureWorkflow({ entry, mode, values, taskId }) {
  const workflow = clone(entry.workflow);
  const bindings = entry.bindings;
  const prompt = String(values?.prompt || "").trim();
  if (!prompt) throw new Error("提示词不能为空");
  const resolution = RESOLUTION_PRESETS[values?.resolutionPreset] || RESOLUTION_PRESETS.balanced;
  const legacyDuration = Number(values?.length) > 0 && Number(values?.fps) > 0 ? Number(values.length) / Number(values.fps) : undefined;
  const duration = finiteNumber(values?.duration ?? values?.sliceDuration ?? legacyDuration, mode === "t2v" ? 5 : 10, 1, 60);
  const seed = integer(values?.seed, Math.floor(Math.random() * Number.MAX_SAFE_INTEGER), 0, Number.MAX_SAFE_INTEGER);
  const assign = (name, value) => setBinding(workflow, bindings[name], value, name);

  assign("prompt", prompt);
  assign("width", resolution.width);
  assign("height", resolution.height);
  assign("fps", GENERATION_FPS);
  assign("bitDepth", integer(values?.bitDepth, 8, 8, 16));
  assign("steps", integer(values?.steps, 20, 1, 200));
  assign("denoise", finiteNumber(values?.denoise, 1, 0, 1));
  assign("scheduler", String(values?.scheduler || "simple"));
  assign("sampler", String(values?.sampler || "res_multistep"));
  assign("seed", seed);
  assign("unetName", String(values?.unetName || "minimax_h3_fl2va_pruned_int8_convrot.safetensors"));
  assign("weightDtype", String(values?.weightDtype || "default"));
  assign("clipName", String(values?.clipName || "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"));
  assign("clipDevice", String(values?.clipDevice || "default"));
  assign("videoVae", String(values?.videoVae || "minimax_h3_video_vae_fp16.safetensors"));
  assign("audioVae", String(values?.audioVae || "minimax_h3_audio_vae_fp32.safetensors"));
  assign("sliceDuration", duration);
  assign("sliceStrict", true);
  assign("format", ["mp4", "webm", "mkv", "auto"].includes(values?.format) ? values.format : "mp4");
  assign("codec", String(values?.codec || "auto"));
  assign("prefix", `video/DSH_${mode}_${Date.now()}_${taskId.slice(0, 8)}`);

  let keyframes = [];
  let frameCount = frameCountForDuration(duration);
  if (mode === "keyframe") {
    keyframes = normalizeKeyframes({ ...values, duration });
    if (bindings.images.length !== keyframes.length || bindings.guides.length !== keyframes.length) throw new Error("关键帧数量与工作流变体不一致");
    assign("length", frameCount);
    keyframes.forEach((item, index) => {
      setBinding(workflow, bindings.images[index], item.image, `images.${index}`);
      setBinding(workflow, bindings.guides[index], item.frameIndex, `guides.${index}`);
    });
  } else {
    assign("duration", duration);
    if (mode === "i2v") {
      const image = String(values?.image || "").trim();
      if (!image) throw new Error("图生视频必须先上传参考图");
      assign("image", image);
    }
  }
  return { workflow, prompt, duration, resolution, frameCount, keyframes };
}
