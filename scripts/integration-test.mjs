import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { apply } from "../lib/index.js";

const requiredNodes = [
  "SaveVideo", "LoadImage", "ResolutionSelector", "VAELoader", "VAEDecodeAudio",
  "KSamplerSelect", "BasicScheduler", "SamplerCustomAdvanced", "BasicGuider",
  "UNETLoader", "CLIPLoader", "RandomNoise", "CreateVideo",
  "MiniMaxH3ImageToVideo", "MiniMaxH3AddImageGuideBackport", "Video Slice", "ComfyMathExpression", "PrimitiveFloat"
];
const videoBytes = Buffer.from("mock-video-payload-for-range-test");
const completed = new Set();
let promptCounter = 0;
let lastPrompt = null;
let optimizationCalls = 0;
let pluginHandler = null;
const disposers = [];
const clients = new Set();

async function disposeAll() {
  for (const disposer of disposers.splice(0).reverse()) await disposer();
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sendJson(res, value) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

const comfyServer = createServer(async (req, res) => {
  const url = new URL(req.url, "http://local.test");
  if (url.pathname === "/system_stats") return sendJson(res, { system: { os: "mock" } });
  if (url.pathname === "/object_info") return sendJson(res, Object.fromEntries(requiredNodes.map((name) => [name, {}])));
  if (url.pathname === "/upload/image") {
    await body(req);
    return sendJson(res, { name: "reference.png", subfolder: "", type: "input" });
  }
  if (url.pathname === "/prompt") {
    lastPrompt = JSON.parse((await body(req)).toString("utf8"));
    const promptId = `prompt-test-${++promptCounter}`;
    sendJson(res, { prompt_id: promptId, number: promptCounter, node_errors: {} });
    setTimeout(() => {
      for (const client of clients) {
        client.send(JSON.stringify({ type: "execution_start", data: { prompt_id: promptId } }));
        client.send(JSON.stringify({ type: "executing", data: { prompt_id: promptId, node: "sampler" } }));
        client.send(JSON.stringify({ type: "progress", data: { prompt_id: promptId, value: 10, max: 20 } }));
      }
    }, 30);
    setTimeout(() => {
      completed.add(promptId);
      for (const client of clients) client.send(JSON.stringify({ type: "execution_success", data: { prompt_id: promptId } }));
    }, 80);
    return;
  }
  const historyMatch = /^\/history\/(prompt-test-\d+)$/.exec(url.pathname);
  if (historyMatch) {
    const promptId = historyMatch[1];
    return sendJson(res, completed.has(promptId) ? {
      [promptId]: { outputs: { output: { videos: [{ filename: `${promptId}.mp4`, subfolder: "video", type: "output" }] } } }
    } : {});
  }
  if (url.pathname === "/view") {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": videoBytes.length });
    res.end(videoBytes);
    return;
  }
  if (url.pathname === "/interrupt" || url.pathname === "/queue") return sendJson(res, {});
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });
comfyServer.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, "http://local.test").pathname !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
});
wss.on("connection", (client) => {
  clients.add(client);
  client.on("close", () => clients.delete(client));
});

await new Promise((resolveListen) => comfyServer.listen(0, "127.0.0.1", resolveListen));
const comfyPort = comfyServer.address().port;

const ctx = {
  webServer: {
    register(route) {
      pluginHandler = route.handler;
      return () => { pluginHandler = null; };
    }
  },
  llm: {
    async *stream(options) {
      optimizationCalls += 1;
      const input = options.messages?.[0]?.content?.[0]?.text || "";
      const text = input.includes("含糊")
        ? JSON.stringify({ decision: "clarify", reason: "主体行为不明确", questions: ["主体最终要完成什么动作？"] })
        : input.includes("缺规则") && !input.includes("上次输出遗漏规则")
          ? JSON.stringify({ decision: "ready", summary: "故意遗漏", prompt: "不完整提示词", appliedRules: ["portrait_9_16"], overriddenRules: {} })
        : JSON.stringify({
          decision: "ready",
          summary: "补全动作和镜头",
          prompt: "9:16 手机竖屏，电影级雪原中一只猫高速奔跑，低机位平滑手持跟拍，雪粒飞溅。",
          appliedRules: ["smooth_rotation", "portrait_9_16", "handheld_motion", "fixed_body_direction", "fixed_gaze", "natural_blink"],
          overriddenRules: {}
        });
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  },
  agents: { get(id) { return id === "session-1" ? { id } : undefined; } },
  logger: { warn() {}, error() {} },
  effect(factory) {
    const disposer = factory();
    if (typeof disposer === "function") disposers.push(disposer);
    return disposer;
  }
};

const outputRoot = await mkdtemp(join(tmpdir(), "dsh-comfy-video-test-"));
const customWorkflowDirectory = join(outputRoot, "workflow-presets");
const workflowAssets = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "workflows");
await cp(workflowAssets, customWorkflowDirectory, { recursive: true });
const copiedManifestPath = join(customWorkflowDirectory, "minimax-h3-default.preset.json");
const customManifest = JSON.parse(await readFile(copiedManifestPath, "utf8"));
customManifest.id = "minimax-h3-custom";
customManifest.name = "MiniMax H3 自定义测试预设";
await writeFile(join(customWorkflowDirectory, "minimax-h3-custom.preset.json"), `${JSON.stringify(customManifest, null, 2)}\n`);
await rm(copiedManifestPath);
const pluginConfig = {
  connectionPresets: [
    { id: "primary", name: "主 ComfyUI", baseUrl: `http://127.0.0.1:${comfyPort}` },
    { id: "secondary", name: "备用 ComfyUI", baseUrl: `http://127.0.0.1:${comfyPort}` }
  ],
  defaultConnectionPresetId: "primary",
  requestTimeoutMs: 5000,
  maxUploadMb: 5,
  historyFile: join(outputRoot, "history.json"),
  workflowDirectory: customWorkflowDirectory
};
apply(ctx, pluginConfig);
assert.equal(typeof pluginHandler, "function");

const pluginServer = createServer((req, res) => pluginHandler(req, res));
await new Promise((resolveListen) => pluginServer.listen(0, "127.0.0.1", resolveListen));
const pluginBase = `http://127.0.0.1:${pluginServer.address().port}/comfy-video/api`;

try {
  const health = await (await fetch(`${pluginBase}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.connection.id, "primary");
  const connectionCatalog = await (await fetch(`${pluginBase}/connections`)).json();
  assert.equal(connectionCatalog.defaultId, "primary");
  assert.deepEqual(connectionCatalog.presets.map((item) => item.id), ["primary", "secondary"]);
  const secondaryHealth = await (await fetch(`${pluginBase}/health?connectionPresetId=secondary`)).json();
  assert.equal(secondaryHealth.connection.id, "secondary");
  const workflowCatalog = await (await fetch(`${pluginBase}/workflows`)).json();
  assert.equal(workflowCatalog.defaultId, "minimax-h3-default");
  assert.equal(workflowCatalog.presets.length, 2);
  assert.equal(workflowCatalog.presets.every((preset) => preset.modes.includes("keyframe")), true);
  await writeFile(join(customWorkflowDirectory, "broken.preset.json"), '{"schemaVersion":1,"id":"broken-preset","name":"Broken","modes":{}}');
  const refreshedWithInvalid = await (await fetch(`${pluginBase}/workflows/refresh`, { method: "POST" })).json();
  assert.equal(refreshedWithInvalid.invalid.length, 1);
  await rm(join(customWorkflowDirectory, "broken.preset.json"));
  const refreshed = await (await fetch(`${pluginBase}/workflows/refresh`, { method: "POST" })).json();
  assert.equal(refreshed.invalid.length, 0);

  const upload = await (await fetch(`${pluginBase}/upload?connectionPresetId=secondary`, {
    method: "POST",
    headers: { "content-type": "image/png", "x-file-name": encodeURIComponent("reference.png") },
    body: Buffer.from("png")
  })).json();
  assert.equal(upload.name, "reference.png");

  const customTemplate = await (await fetch(`${pluginBase}/templates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "我的运镜", mode: "keyframe", prompt: "A 到 B 再回到 A，最后转向 C。" })
  })).json();
  assert.equal(customTemplate.name, "我的运镜");
  assert.equal((await (await fetch(`${pluginBase}/templates`)).json()).length, 1);
  const updatedTemplate = await (await fetch(`${pluginBase}/templates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: customTemplate.id, name: "我的关键帧运镜", mode: "keyframe", prompt: "A 到 B 平滑过渡，再回到 A，最后转向 C。" })
  })).json();
  assert.equal(updatedTemplate.name, "我的关键帧运镜");

  const optimized = await (await fetch(`${pluginBase}/optimize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "session-1", provider: "mock-provider", model: "mock-model", mode: "t2v", prompt: "猫在雪地奔跑" })
  })).json();
  assert.equal(optimized.decision, "ready");
  assert.match(optimized.prompt, /平滑手持跟拍/);
  assert.equal(optimized.appliedRules.length, 6);

  const callsBeforeRetry = optimizationCalls;
  const retriedOptimization = await (await fetch(`${pluginBase}/optimize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "session-1", provider: "mock-provider", model: "mock-model", mode: "t2v", prompt: "缺规则测试" })
  })).json();
  assert.equal(retriedOptimization.decision, "ready");
  assert.equal(optimizationCalls - callsBeforeRetry, 2);

  const clarification = await (await fetch(`${pluginBase}/optimize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "session-1", provider: "mock-provider", model: "mock-model", mode: "t2v", prompt: "一个含糊的场景" })
  })).json();
  assert.equal(clarification.decision, "clarify");
  assert.deepEqual(clarification.questions, ["主体最终要完成什么动作？"]);

  const createdResponse = await fetch(`${pluginBase}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "i2v",
      connectionPresetId: "secondary",
      workflowPresetId: "minimax-h3-custom",
      values: {
        prompt: "参考图中的猫在雪地奔跑",
        image: "reference.png",
        outputDirectory: outputRoot,
        resolutionPreset: "quality",
        duration: 7,
        steps: 28,
        seed: 12345,
        format: "mp4"
      }
    })
  });
  assert.equal(createdResponse.status, 202);
  const created = await createdResponse.json();
  assert.equal(created.connectionPresetId, "secondary");
  assert.equal(created.connectionName, "备用 ComfyUI");
  assert.equal(created.workflowPresetId, "minimax-h3-custom");
  assert.equal(lastPrompt.prompt["114"].inputs.image, "reference.png");
  assert.equal(lastPrompt.prompt["105:111"].inputs.value, 7);
  assert.equal(lastPrompt.prompt["105:104"].inputs.width, 768);
  assert.equal(lastPrompt.prompt["105:104"].inputs.height, 1344);
  assert.equal(lastPrompt.prompt["105:91"].inputs.fps, 24);
  assert.equal(lastPrompt.prompt["105:9"].inputs.steps, 28);
  assert.equal(lastPrompt.prompt["121"].inputs.duration, 7);
  assert.equal(lastPrompt.prompt["121"].inputs.strict_duration, true);

  let task;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    task = await (await fetch(`${pluginBase}/tasks/${created.id}`)).json();
    if (task.status === "completed" || task.status === "failed") break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.equal(task.status, "completed", task.error);
  assert.equal((await readFile(task.outputPath)).toString(), videoBytes.toString());

  const ranged = await fetch(`http://127.0.0.1:${pluginServer.address().port}${task.videoUrl}`, { headers: { range: "bytes=0-3" } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 4);

  const keyframeResponse = await fetch(`${pluginBase}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "keyframe",
      workflowPresetId: "minimax-h3-default",
      values: {
        prompt: "镜头依次经过 @K2、@K3、@K1，人物保持正视前方。",
        keyframes: [
          { ref: "K1", image: "late.png", timeSeconds: 8 },
          { ref: "K2", image: "opening.png", timeSeconds: 0 },
          { ref: "K3", image: "middle.png", timeSeconds: 5 }
        ],
        outputDirectory: outputRoot,
        resolutionPreset: "quality",
        duration: 10,
        steps: 24,
        seed: 9876,
        format: "mp4"
      }
    })
  });
  assert.equal(keyframeResponse.status, 202);
  const keyframeTask = await keyframeResponse.json();
  assert.equal(lastPrompt.prompt["2"].inputs.prompt, "镜头依次经过 @K2、@K3、@K1，人物保持正视前方。");
  assert.equal(lastPrompt.prompt["2"].inputs.width, 768);
  assert.equal(lastPrompt.prompt["2"].inputs.height, 1344);
  assert.equal(lastPrompt.prompt["2"].inputs.length, 243);
  assert.equal(lastPrompt.prompt["22"].inputs.image, "opening.png");
  assert.equal(lastPrompt.prompt["23"].inputs.image, "middle.png");
  assert.equal(lastPrompt.prompt["24"].inputs.image, "late.png");
  assert.deepEqual(["30", "31", "32"].map((id) => lastPrompt.prompt[id].inputs.frame_idx), [0, 120, 192]);
  assert.equal(lastPrompt.prompt["19"].inputs.fps, 24);
  assert.equal(lastPrompt.prompt["15"].inputs.steps, 24);
  assert.equal(lastPrompt.prompt["28"].inputs.duration, 10);
  assert.equal(lastPrompt.prompt["28"].inputs.strict_duration, true);
  assert.equal(keyframeTask.workflowPresetId, "minimax-h3-default");
  assert.deepEqual(keyframeTask.keyframes.map((item) => item.ref), ["K2", "K3", "K1"]);

  let completedKeyframeTask;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    completedKeyframeTask = await (await fetch(`${pluginBase}/tasks/${keyframeTask.id}`)).json();
    if (completedKeyframeTask.status === "completed" || completedKeyframeTask.status === "failed") break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.equal(completedKeyframeTask.status, "completed", completedKeyframeTask.error);

  for (const sample of [
    [{ ref: "K1", image: "single.png", timeSeconds: 2.25 }],
    [{ ref: "K1", image: "first.png", timeSeconds: .5 }, { ref: "K2", image: "second.png", timeSeconds: 7.75 }]
  ]) {
    const response = await fetch(`${pluginBase}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "keyframe",
        values: { prompt: "按关键帧连续运镜。", keyframes: sample, duration: 10, outputDirectory: outputRoot }
      })
    });
    assert.equal(response.status, 202);
    const variantTask = await response.json();
    assert.equal(Object.hasOwn(lastPrompt.prompt, String(29 + sample.length)), true);
    assert.equal(Object.hasOwn(lastPrompt.prompt, String(30 + sample.length)), false);
    assert.deepEqual(sample.map((_, index) => lastPrompt.prompt[String(30 + index)].inputs.frame_idx), sample.map((item) => Math.round(item.timeSeconds * 24)));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await (await fetch(`${pluginBase}/tasks/${variantTask.id}`)).json();
      if (status.status === "completed") break;
      if (status.status === "failed") assert.fail(status.error);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }

  const duplicateTime = await fetch(`${pluginBase}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "keyframe", values: {
      prompt: "重复时间测试", outputDirectory: outputRoot, duration: 10,
      keyframes: [{ image: "a.png", timeSeconds: 1 }, { image: "b.png", timeSeconds: 1.01 }]
    } })
  });
  assert.equal(duplicateTime.status, 400);
  assert.match((await duplicateTime.json()).error, /重复在第/);

  const legacyResponse = await fetch(`${pluginBase}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "keyframe", values: {
      prompt: "旧版三图请求兼容测试", outputDirectory: outputRoot,
      keyframeA: "legacy-a.png", keyframeB: "legacy-b.png", keyframeC: "legacy-c.png",
      keyframeIndexB: 125, keyframeIndexC: 225, fps: 25, sliceDuration: 9.5
    } })
  });
  assert.equal(legacyResponse.status, 202);
  const legacyTask = await legacyResponse.json();
  assert.deepEqual(["30", "31", "32"].map((id) => lastPrompt.prompt[id].inputs.frame_idx), [0, 120, 216]);
  assert.deepEqual(["22", "23", "24"].map((id) => lastPrompt.prompt[id].inputs.image), ["legacy-a.png", "legacy-b.png", "legacy-c.png"]);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await (await fetch(`${pluginBase}/tasks/${legacyTask.id}`)).json();
    if (status.status === "completed") break;
    if (status.status === "failed") assert.fail(status.error);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }

  await disposeAll();
  apply(ctx, {
    ...pluginConfig,
    connectionPresets: [pluginConfig.connectionPresets[0]],
    defaultConnectionPresetId: "primary"
  });
  const restored = await (await fetch(`${pluginBase}/tasks`)).json();
  assert.equal(restored.length, 5);
  assert.equal(restored[0].status, "completed");
  assert.equal(restored.some((task) => task.connectionPresetId === "secondary"), true);
  assert.equal((await (await fetch(`${pluginBase}/connections`)).json()).presets.length, 1);
  assert.equal((await (await fetch(`${pluginBase}/templates`)).json())[0].name, "我的关键帧运镜");

  const cleared = await (await fetch(`${pluginBase}/tasks`, { method: "DELETE" })).json();
  assert.equal(cleared.removed, 5);
  assert.deepEqual(await (await fetch(`${pluginBase}/tasks`)).json(), []);
  const removedTemplate = await (await fetch(`${pluginBase}/templates/${customTemplate.id}`, { method: "DELETE" })).json();
  assert.equal(removedTemplate.removed, 1);
  assert.deepEqual(await (await fetch(`${pluginBase}/templates`)).json(), []);
  console.log("integration test passed: connection preset switching, keyframe workflow mapping, custom template CRUD/persistence, history reload/clear, optimization, progress, absolute output, range playback");
} finally {
  await disposeAll();
  await new Promise((resolveClose) => pluginServer.close(resolveClose));
  for (const client of clients) client.close();
  await new Promise((resolveClose) => comfyServer.close(resolveClose));
  await rm(outputRoot, { recursive: true, force: true });
}
