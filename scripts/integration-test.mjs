import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { apply } from "../lib/index.js";

const workflow = {
  "1": { class_type: "LoadVideo", inputs: { file: "input.mp4" }, _meta: { title: "输入视频" } },
  "2": { class_type: "SaveVideo", inputs: { video: ["1", 0], filename_prefix: "video/master", format: "mp4", codec: "auto" }, _meta: { title: "母版" } },
  "3": { class_type: "SaveVideo", inputs: { video: ["1", 0], filename_prefix: "video/final", format: "mp4", codec: "auto" }, _meta: { title: "最终视频" } }
};
const objectInfo = {
  LoadVideo: { input: { required: { file: [[], { video_upload: true }] } }, output: ["VIDEO"], category: "video" },
  SaveVideo: { input: { required: { video: ["VIDEO", {}], filename_prefix: ["STRING", {}], format: [["mp4"], {}], codec: [["auto"], {}] } }, output: ["VIDEO"], output_node: true, category: "video" }
};

const completed = new Set();
const submitted = [];
const promptBodies = new Map();
const websocketClients = new Set();
let promptCounter = 0;
let pluginHandler = null;
let disposers = [];

function sendJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const comfyServer = createServer(async (req, res) => {
  const url = new URL(req.url, "http://mock.local");
  if (url.pathname === "/system_stats") return sendJson(res, { system: { os: "mock" }, devices: [{ name: "Mock GPU", vram_total: 16 * 1024 ** 3, vram_free: 12 * 1024 ** 3 }] });
  if (url.pathname === "/object_info") return sendJson(res, objectInfo);
  if (url.pathname === "/queue" && req.method === "GET") {
    const active = submitted.filter((id) => !completed.has(id));
    return sendJson(res, { queue_running: active.slice(0, 1).map((id) => [0, id]), queue_pending: active.slice(1).map((id) => [0, id]) });
  }
  if (url.pathname === "/queue" && req.method === "POST") {
    const body = JSON.parse((await requestBody(req)).toString("utf8"));
    for (const id of body.delete || []) completed.add(id);
    return sendJson(res, {});
  }
  if (url.pathname === "/upload/image") {
    await requestBody(req);
    return sendJson(res, { name: "uploaded.mp4", subfolder: "", type: "input" });
  }
  if (url.pathname === "/prompt") {
    const body = JSON.parse((await requestBody(req)).toString("utf8"));
    const promptId = `prompt-${++promptCounter}`;
    submitted.push(promptId);
    promptBodies.set(promptId, body);
    sendJson(res, { prompt_id: promptId, number: promptCounter, node_errors: {} });
    setTimeout(() => {
      for (const client of websocketClients) client.send(JSON.stringify({ type: "execution_start", data: { prompt_id: promptId } }));
    }, 10);
    return;
  }
  const historyMatch = /^\/history\/(prompt-\d+)$/.exec(url.pathname);
  if (historyMatch) {
    const id = historyMatch[1];
    return sendJson(res, completed.has(id) ? {
      [id]: { outputs: {
        "2": { videos: [{ filename: `${id}-master.mp4`, subfolder: "video", type: "output" }] },
        "3": { videos: [{ filename: `${id}-final.mp4`, subfolder: "video", type: "output" }] }
      } }
    } : {});
  }
  if (url.pathname === "/view") {
    const bytes = Buffer.from(`mock-video:${url.searchParams.get("filename")}`);
    res.writeHead(200, { "content-type": "video/mp4", "content-length": bytes.length });
    return res.end(bytes);
  }
  if (url.pathname === "/interrupt") return sendJson(res, {});
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });
comfyServer.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, "http://mock.local").pathname !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client));
});
wss.on("connection", (client) => {
  websocketClients.add(client);
  client.on("close", () => websocketClients.delete(client));
});

await new Promise((resolveListen) => comfyServer.listen(0, "127.0.0.1", resolveListen));
const comfyPort = comfyServer.address().port;
const temporary = await mkdtemp(join(tmpdir(), "dsh-comfy-dynamic-"));

const ctx = {
  webServer: { register(route) { pluginHandler = route.handler; return () => { pluginHandler = null; }; } },
  logger: { warn() {}, error() {} },
  effect(factory) { const disposer = factory(); if (typeof disposer === "function") disposers.push(disposer); return disposer; }
};
const config = {
  baseUrl: `http://127.0.0.1:${comfyPort}`,
  requestTimeoutMs: 5000,
  historyFile: join(temporary, "history.json"),
  connectionsFile: join(temporary, "connections.json"),
  workflowDirectory: join(temporary, "workflows")
};
apply(ctx, config);
const pluginServer = createServer((req, res) => pluginHandler(req, res));
await new Promise((resolveListen) => pluginServer.listen(0, "127.0.0.1", resolveListen));
const base = `http://127.0.0.1:${pluginServer.address().port}/comfy-video/api`;

async function waitFor(predicate, message, attempts = 120) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  assert.fail(message);
}

function finishPrompt(id) {
  completed.add(id);
  for (const client of websocketClients) client.send(JSON.stringify({ type: "execution_success", data: { prompt_id: id } }));
}

async function disposePlugin() {
  for (const disposer of disposers.splice(0).reverse()) await disposer();
}

try {
  const connections = await (await fetch(`${base}/connections`)).json();
  assert.equal(connections.presets[0].maxConcurrency, 1);
  const health = await (await fetch(`${base}/connections/default/health?deep=1`)).json();
  assert.equal(health.status, "online");
  assert.equal(health.objectInfoNodeCount, 2);

  const inspectedResponse = await fetch(`${base}/workflows/inspect?connectionPresetId=default`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-file-name": "pass-through-api.json" },
    body: JSON.stringify(workflow)
  });
  assert.equal(inspectedResponse.status, 200);
  const inspected = await inspectedResponse.json();
  assert.equal(inspected.analysis.ok, true);
  assert.deepEqual(inspected.analysis.outputs.map((item) => item.nodeId), ["2", "3"]);

  const savedResponse = await fetch(`${base}/workflows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Pass-through video", sourceFileName: "pass-through-api.json", workflow, fields: inspected.analysis.fields, primaryOutputNodeId: "3" })
  });
  assert.equal(savedResponse.status, 201);
  const saved = await savedResponse.json();
  assert.equal((await (await fetch(`${base}/workflows`)).json()).length, 1);
  assert.equal((await (await fetch(`${base}/workflows/${saved.id}/compatibility?connectionPresetId=default`)).json()).ok, true);

  const upload = await (await fetch(`${base}/upload?connectionPresetId=default`, {
    method: "POST",
    headers: { "content-type": "video/mp4", "x-file-name": "input.mp4" },
    body: Buffer.from("video")
  })).json();
  assert.equal(upload.name, "uploaded.mp4");

  const create = () => fetch(`${base}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflowId: saved.id, connectionPresetId: "default", outputDirectory: temporary, values: { "1.file": "uploaded.mp4" } })
  }).then(async (response) => {
    if (response.status !== 202) assert.fail(`task creation failed: ${response.status} ${await response.text()}`);
    return response.json();
  });

  const first = await create();
  const second = await create();
  await waitFor(() => submitted.length === 1, "concurrency 1 should submit only one task");
  assert.equal(promptBodies.get(submitted[0]).prompt["1"].inputs.file, "uploaded.mp4");
  finishPrompt(submitted[0]);
  await waitFor(() => submitted.length === 2, "second task should dispatch after first completes");
  finishPrompt(submitted[1]);

  const completedTasks = await waitFor(async () => {
    const tasks = await (await fetch(`${base}/tasks`)).json();
    return tasks.filter((task) => [first.id, second.id].includes(task.id)).every((task) => task.status === "completed") ? tasks : null;
  }, "tasks did not complete");
  const firstView = completedTasks.find((task) => task.id === first.id);
  assert.equal(firstView.outputs.length, 2);
  assert.match(firstView.videoUrl, /\/1$/, "primary node 3 must select the second output");
  assert.match((await readFile(firstView.outputs[1].outputPath)).toString(), /final/);
  const range = await fetch(`http://127.0.0.1:${pluginServer.address().port}${firstView.videoUrl}`, { headers: { range: "bytes=0-3" } });
  assert.equal(range.status, 206);

  const queuePatch = await fetch(`${base}/connections/default/queue`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxConcurrency: 2 }) });
  assert.equal(queuePatch.status, 200);
  assert.equal((await queuePatch.json()).maxConcurrency, 2);
  const before = submitted.length;
  const batch = [await create(), await create(), await create()];
  await waitFor(() => submitted.length === before + 2, "concurrency 2 should submit two tasks");
  finishPrompt(submitted[before]);
  await waitFor(() => submitted.length === before + 3, "third task should remain local until a slot opens");
  finishPrompt(submitted[before + 1]);
  finishPrompt(submitted[before + 2]);
  await waitFor(async () => {
    const tasks = await (await fetch(`${base}/tasks`)).json();
    return batch.every((item) => tasks.find((task) => task.id === item.id)?.status === "completed");
  }, "concurrency 2 batch did not complete");

  const queuePatchThree = await fetch(`${base}/connections/default/queue`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxConcurrency: 3 }) });
  assert.equal((await queuePatchThree.json()).maxConcurrency, 3);
  const beforeThree = submitted.length;
  const batchThree = [await create(), await create(), await create(), await create()];
  await waitFor(() => submitted.length === beforeThree + 3, "concurrency 3 should submit three tasks");
  finishPrompt(submitted[beforeThree]);
  await waitFor(() => submitted.length === beforeThree + 4, "fourth task should wait for one of three slots");
  for (const id of submitted.slice(beforeThree + 1, beforeThree + 4)) finishPrompt(id);
  await waitFor(async () => {
    const tasks = await (await fetch(`${base}/tasks`)).json();
    return batchThree.every((item) => tasks.find((task) => task.id === item.id)?.status === "completed");
  }, "concurrency 3 batch did not complete");

  await disposePlugin();
  apply(ctx, config);
  const restoredWorkflows = await (await fetch(`${base}/workflows`)).json();
  const restoredTasks = await (await fetch(`${base}/tasks`)).json();
  assert.equal(restoredWorkflows.length, 1);
  assert.equal(restoredTasks.length, 9);
  assert.equal((await (await fetch(`${base}/connections`)).json()).presets[0].maxConcurrency, 3);

  const updated = await (await fetch(`${base}/workflows/${saved.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Renamed workflow", fields: saved.fields }) })).json();
  assert.equal(updated.name, "Renamed workflow");
  assert.equal((await (await fetch(`${base}/workflows/${saved.id}`, { method: "DELETE" })).json()).removed, 1);
  assert.equal((await (await fetch(`${base}/tasks`, { method: "DELETE" })).json()).removed, 9);
  console.log("integration test passed: workflow import/compatibility/persistence, media upload, multi-output, FIFO concurrency 1/2/3, task restore and CRUD");
} finally {
  await disposePlugin();
  await new Promise((resolveClose) => pluginServer.close(resolveClose));
  for (const client of websocketClients) client.close();
  await new Promise((resolveClose) => comfyServer.close(resolveClose));
  await rm(temporary, { recursive: true, force: true });
}
