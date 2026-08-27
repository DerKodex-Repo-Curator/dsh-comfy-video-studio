import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsRoot = join(root, "assets", "workflows");
const readJson = async (name) => JSON.parse(await readFile(join(workflowsRoot, name), "utf8"));
const writeJson = async (name, value) => writeFile(join(workflowsRoot, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");

const DEFAULT_PROMPT = [
  "9:16 手机竖屏真实手持拍摄。",
  "镜头转动平滑连续，非明确要求时停顿不超过 500ms，并带轻微自然手抖。",
  "镜头移动时人物头部、身体方向和视线保持原方向，不跟随镜头转动或追随镜头。",
  "人物自然眨眼，平均每 3 到 8 秒一次。"
].join("");

function withStrictSlice(workflow, mode) {
  const next = structuredClone(workflow);
  delete next["115"];
  delete next["119"];
  delete next["120"];
  next["105:104"].inputs.prompt = DEFAULT_PROMPT;
  next["105:104"].inputs.width = 576;
  next["105:104"].inputs.height = 1024;
  next["105:111"].inputs.value = mode === "t2v" ? 5 : 10;
  next["105:91"].inputs.fps = 24;
  next["121"] = {
    inputs: {
      start_time: 0,
      duration: mode === "t2v" ? 5 : 10,
      strict_duration: true,
      video: ["105:91", 0]
    },
    class_type: "Video Slice",
    _meta: { title: "严格裁剪到目标时长", dsh_role: "video_slice" }
  };
  next["92"].inputs.video = ["121", 0];
  for (const [id, role] of Object.entries({
    "105:104": "video_conditioning", "105:111": "duration", "105:91": "create_video",
    "105:9": "scheduler", "105:17": "sampler_select", "105:15": "noise", "105:6": "unet",
    "105:13": "clip", "105:11": "video_vae", "105:24": "audio_vae", "92": "save_video"
  })) next[id]._meta = { ...(next[id]._meta || {}), dsh_role: role };
  if (mode === "i2v") next["114"]._meta = { ...(next["114"]._meta || {}), dsh_role: "reference_image" };
  return next;
}

function keyframeVariant(legacy, count) {
  const keep = new Set(["2", "6", "7", "9", "11", "12", "13", "14", "15", "17", "18", "19", "21", "27", "28"]);
  const next = Object.fromEntries(Object.entries(legacy).filter(([id]) => keep.has(id)).map(([id, node]) => [id, structuredClone(node)]));
  next["2"].inputs = {
    prompt: DEFAULT_PROMPT,
    width: 576,
    height: 1024,
    length: 243,
    clip: ["27", 0],
    vae: ["11", 0]
  };
  next["2"]._meta = { ...(next["2"]._meta || {}), title: "MiniMax H3 通用关键帧", dsh_role: "video_conditioning" };
  const defaultFrames = [0, 120, 192];
  let positive = ["2", 0];
  for (let index = 0; index < count; index += 1) {
    const loadId = String(22 + index);
    const guideId = String(30 + index);
    next[loadId] = {
      inputs: { image: "example.png" },
      class_type: "LoadImage",
      _meta: { title: `关键帧 @K${index + 1}`, dsh_role: `keyframe_image_${index + 1}` }
    };
    next[guideId] = {
      inputs: {
        frame_idx: defaultFrames[index],
        positive,
        latent: ["2", 1],
        vae: ["11", 0],
        image: [loadId, 0]
      },
      class_type: "MiniMaxH3AddImageGuideBackport",
      _meta: { title: `@K${index + 1} 时间约束`, dsh_role: `keyframe_guide_${index + 1}` }
    };
    positive = [guideId, 0];
  }
  next["6"].inputs.conditioning = positive;
  next["19"].inputs.fps = 24;
  next["28"].inputs = { start_time: 0, duration: 10, strict_duration: true, video: ["19", 0] };
  next["21"].inputs.filename_prefix = `video/DSH_Keyframes_${count}`;
  for (const [id, role] of Object.entries({
    "6": "guider", "7": "sampler", "9": "unet", "11": "video_vae", "12": "audio_vae",
    "13": "noise", "14": "sampler_select", "15": "scheduler", "19": "create_video",
    "21": "save_video", "27": "clip", "28": "video_slice"
  })) next[id]._meta = { ...(next[id]._meta || {}), dsh_role: role };
  return next;
}

const OUTPUTS = {
  LoadImage: [["IMAGE", "IMAGE"], ["MASK", "MASK"]],
  CLIPLoader: [["CLIP", "CLIP"]], VAELoader: [["VAE", "VAE"]], UNETLoader: [["MODEL", "MODEL"]],
  MiniMaxH3ImageToVideo: [["positive", "CONDITIONING"], ["LATENT", "LATENT"]],
  MiniMaxH3AddImageGuideBackport: [["positive", "CONDITIONING"]], BasicGuider: [["GUIDER", "GUIDER"]],
  RandomNoise: [["NOISE", "NOISE"]], KSamplerSelect: [["SAMPLER", "SAMPLER"]], BasicScheduler: [["SIGMAS", "SIGMAS"]],
  SamplerCustomAdvanced: [["output", "LATENT"], ["denoised_output", "LATENT"]], VAEDecode: [["IMAGE", "IMAGE"]],
  VAEDecodeAudio: [["AUDIO", "AUDIO"]], CreateVideo: [["VIDEO", "VIDEO"]], "Video Slice": [["VIDEO", "VIDEO"]],
  SaveVideo: [["video", "VIDEO"]], PrimitiveFloat: [["FLOAT", "FLOAT"]], ComfyMathExpression: [["FLOAT", "FLOAT"], ["INT", "INT"]]
};

const INPUT_TYPES = {
  clip: "CLIP", vae: "VAE", first_frame: "IMAGE", last_frame: "IMAGE", positive: "CONDITIONING", latent: "LATENT",
  image: "IMAGE", model: "MODEL", conditioning: "CONDITIONING", noise: "NOISE", guider: "GUIDER", sampler: "SAMPLER",
  sigmas: "SIGMAS", latent_image: "LATENT", samples: "LATENT", images: "IMAGE", audio: "AUDIO", video: "VIDEO",
  "values.a": "FLOAT", width: "INT", height: "INT", length: "INT"
};

const WIDGET_ORDER = {
  LoadImage: ["image"], CLIPLoader: ["clip_name", "type", "device"], VAELoader: ["vae_name"], UNETLoader: ["unet_name", "weight_dtype"],
  MiniMaxH3ImageToVideo: ["prompt", "width", "height", "length"], MiniMaxH3AddImageGuideBackport: ["frame_idx"],
  RandomNoise: ["noise_seed", "control_after_generate"], KSamplerSelect: ["sampler_name"], BasicScheduler: ["scheduler", "steps", "denoise"],
  CreateVideo: ["fps", "bit_depth"], "Video Slice": ["start_time", "duration", "strict_duration"],
  SaveVideo: ["filename_prefix", "format", "codec"], PrimitiveFloat: ["value"], ComfyMathExpression: ["expression"]
};

function canvasWorkflow(api, title, id) {
  const apiIds = Object.keys(api);
  const numeric = new Map(apiIds.map((apiId, index) => [apiId, index + 1]));
  const nodeByApi = new Map();
  const links = [];
  let linkId = 0;
  const stageX = { LoadImage: 40, CLIPLoader: 40, VAELoader: 40, UNETLoader: 40, RandomNoise: 380, PrimitiveFloat: 40, ComfyMathExpression: 380, MiniMaxH3ImageToVideo: 380, MiniMaxH3AddImageGuideBackport: 720, BasicGuider: 1040, KSamplerSelect: 720, BasicScheduler: 720, SamplerCustomAdvanced: 1320, VAEDecode: 1660, VAEDecodeAudio: 1660, CreateVideo: 1960, "Video Slice": 2260, SaveVideo: 2560 };
  const rows = new Map();

  for (const apiId of apiIds) {
    const source = api[apiId];
    const type = source.class_type;
    const x = stageX[type] ?? 380;
    const row = rows.get(x) ?? 0;
    rows.set(x, row + 1);
    const inputEntries = Object.entries(source.inputs || {});
    const connections = inputEntries.filter(([, value]) => Array.isArray(value) && value.length === 2 && numeric.has(String(value[0])) && Number.isInteger(Number(value[1])));
    const widgets = (WIDGET_ORDER[type] || []).filter((name) => Object.hasOwn(source.inputs || {}, name)).map((name) => source.inputs[name]);
    const outputs = (OUTPUTS[type] || []).map(([name, outputType]) => ({ name, type: outputType, links: null }));
    const node = {
      id: numeric.get(apiId), type, pos: [x, 60 + row * 210], size: [type === "MiniMaxH3ImageToVideo" ? 320 : 260, type === "MiniMaxH3ImageToVideo" ? 190 : 120],
      flags: {}, order: numeric.get(apiId), mode: 0,
      inputs: connections.map(([name]) => ({ name, type: INPUT_TYPES[name] || "*", link: null })), outputs,
      properties: { "Node name for S&R": type, dsh_role: source._meta?.dsh_role || "" }, widgets_values: widgets
    };
    if (source._meta?.title) node.title = source._meta.title;
    nodeByApi.set(apiId, node);
  }

  for (const [targetApiId, source] of Object.entries(api)) {
    const target = nodeByApi.get(targetApiId);
    for (const [name, value] of Object.entries(source.inputs || {})) {
      if (!Array.isArray(value) || value.length !== 2 || !nodeByApi.has(String(value[0]))) continue;
      const origin = nodeByApi.get(String(value[0]));
      const originSlot = Number(value[1]);
      const targetSlot = target.inputs.findIndex((input) => input.name === name);
      if (targetSlot < 0 || !origin.outputs[originSlot]) continue;
      linkId += 1;
      const transported = INPUT_TYPES[name] || origin.outputs[originSlot].type;
      links.push([linkId, origin.id, originSlot, target.id, targetSlot, transported]);
      origin.outputs[originSlot].links ||= [];
      origin.outputs[originSlot].links.push(linkId);
      target.inputs[targetSlot].link = linkId;
    }
  }

  return {
    id, revision: 0, last_node_id: apiIds.length, last_link_id: linkId,
    nodes: [...nodeByApi.values()], links,
    groups: [{ title, bounding: [20, 20, 2820, Math.max(520, ...[...nodeByApi.values()].map((node) => node.pos[1] + node.size[1]))], color: "#6b5dd3", font_size: 24 }],
    config: {}, extra: { info: { name: title, author: "DeepSeekHarness Video Studio" } }, version: 0.4
  };
}

const t2v = withStrictSlice(await readJson("video_minimax_h3_t2v.json"), "t2v");
const i2v = withStrictSlice(await readJson("video_minimax_h3_i2v.json"), "i2v");
const legacyKeyframe = await readJson("video_minimax_h3_keyframe.json");
const keyframes = Object.fromEntries([1, 2, 3].map((count) => [count, keyframeVariant(legacyKeyframe, count)]));

await writeJson("video_minimax_h3_t2v.json", t2v);
await writeJson("video_minimax_h3_i2v.json", i2v);
for (const [count, workflow] of Object.entries(keyframes)) await writeJson(`video_minimax_h3_keyframe_${count}.json`, workflow);

await writeJson("video_minimax_h3_t2v.workflow.json", canvasWorkflow(t2v, "MiniMax H3 文生视频", "d5b17b37-43b1-4c65-a101-000000000001"));
await writeJson("video_minimax_h3_i2v.workflow.json", canvasWorkflow(i2v, "MiniMax H3 图生视频", "d5b17b37-43b1-4c65-a101-000000000002"));
for (const [count, workflow] of Object.entries(keyframes)) {
  await writeJson(`video_minimax_h3_keyframe_${count}.workflow.json`, canvasWorkflow(workflow, `MiniMax H3 ${count} 关键帧视频`, `d5b17b37-43b1-4c65-a101-00000000000${Number(count) + 2}`));
}

const commonBindings = {
  prompt: { node: "105:104", input: "prompt" }, width: { node: "105:104", input: "width" }, height: { node: "105:104", input: "height" },
  duration: { node: "105:111", input: "value" }, fps: { node: "105:91", input: "fps" }, bitDepth: { node: "105:91", input: "bit_depth" },
  steps: { node: "105:9", input: "steps" }, denoise: { node: "105:9", input: "denoise" }, scheduler: { node: "105:9", input: "scheduler" },
  sampler: { node: "105:17", input: "sampler_name" }, seed: { node: "105:15", input: "noise_seed" }, unetName: { node: "105:6", input: "unet_name" },
  weightDtype: { node: "105:6", input: "weight_dtype" }, clipName: { node: "105:13", input: "clip_name" }, clipDevice: { node: "105:13", input: "device" },
  videoVae: { node: "105:11", input: "vae_name" }, audioVae: { node: "105:24", input: "vae_name" }, sliceDuration: { node: "121", input: "duration" },
  sliceStrict: { node: "121", input: "strict_duration" }, format: { node: "92", input: "format" }, codec: { node: "92", input: "codec" }, prefix: { node: "92", input: "filename_prefix" }
};
const keyframeBindings = (count) => ({
  prompt: { node: "2", input: "prompt" }, width: { node: "2", input: "width" }, height: { node: "2", input: "height" }, length: { node: "2", input: "length" },
  fps: { node: "19", input: "fps" }, bitDepth: { node: "19", input: "bit_depth" }, steps: { node: "15", input: "steps" }, denoise: { node: "15", input: "denoise" },
  scheduler: { node: "15", input: "scheduler" }, sampler: { node: "14", input: "sampler_name" }, seed: { node: "13", input: "noise_seed" },
  unetName: { node: "9", input: "unet_name" }, weightDtype: { node: "9", input: "weight_dtype" }, clipName: { node: "27", input: "clip_name" }, clipDevice: { node: "27", input: "device" },
  videoVae: { node: "11", input: "vae_name" }, audioVae: { node: "12", input: "vae_name" }, sliceDuration: { node: "28", input: "duration" },
  sliceStrict: { node: "28", input: "strict_duration" }, format: { node: "21", input: "format" }, codec: { node: "21", input: "codec" }, prefix: { node: "21", input: "filename_prefix" },
  images: Array.from({ length: count }, (_, index) => ({ node: String(22 + index), input: "image" })),
  guides: Array.from({ length: count }, (_, index) => ({ node: String(30 + index), input: "frame_idx" }))
});

await writeJson("minimax-h3-default.preset.json", {
  schemaVersion: 1,
  id: "minimax-h3-default",
  name: "MiniMax H3 默认工作流",
  description: "24 FPS，9:16 双分辨率，严格时长切片，支持 1-3 个任意时刻关键帧。",
  modes: {
    t2v: { api: "video_minimax_h3_t2v.json", canvas: "video_minimax_h3_t2v.workflow.json", bindings: commonBindings },
    i2v: { api: "video_minimax_h3_i2v.json", canvas: "video_minimax_h3_i2v.workflow.json", bindings: { ...commonBindings, image: { node: "114", input: "image" } } },
    keyframe: {
      variants: Object.fromEntries([1, 2, 3].map((count) => [count, {
        api: `video_minimax_h3_keyframe_${count}.json`, canvas: `video_minimax_h3_keyframe_${count}.workflow.json`, bindings: keyframeBindings(count)
      }]))
    }
  }
});

console.log("generated MiniMax H3 API workflows, canvas workflows, and preset manifest");
