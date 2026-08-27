import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const patch = await readFile(join(root, "cordis.patch.yml"), "utf8");
const host = await readFile(join(root, "lib", "index.js"), "utf8");
const client = await readFile(join(root, "lib", "client.js"), "utf8");

for (const file of [
  "assets/workflows/video_minimax_h3_i2v.json",
  "assets/workflows/video_minimax_h3_t2v.json",
  "assets/workflows/video_minimax_h3_keyframe_1.json",
  "assets/workflows/video_minimax_h3_keyframe_2.json",
  "assets/workflows/video_minimax_h3_keyframe_3.json",
  "assets/workflows/video_minimax_h3_t2v.workflow.json",
  "assets/workflows/video_minimax_h3_i2v.workflow.json",
  "assets/workflows/video_minimax_h3_keyframe_1.workflow.json",
  "assets/workflows/video_minimax_h3_keyframe_2.workflow.json",
  "assets/workflows/video_minimax_h3_keyframe_3.workflow.json",
  "assets/workflows/minimax-h3-default.preset.json",
  "lib/index.js",
  "lib/workflow-presets.js",
  "lib/client.js",
  "README.md"
]) await access(join(root, file));

if (pkg.name !== "dsh-comfy-video-studio") throw new Error("package name mismatch");
if (pkg.dsh?.bundle?.patch !== "./cordis.patch.yml") throw new Error("missing dsh bundle patch");
for (const dependency of [
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-ui-layout",
  "@deepseek-ai/dsh-client-ui-sidebar"
]) {
  if (!pkg.dsh?.client?.inject?.includes(dependency)) throw new Error(`missing client dependency: ${dependency}`);
}
if (!patch.includes("name: dsh-comfy-video-studio")) throw new Error("bundle patch does not mount the plugin");
for (const marker of [
  "ctx.webServer.register",
  "ctx.llm.stream",
  'path: API_PREFIX',
  'kind: "prefix"',
  "Readable.fromWeb",
  "content-range",
  "historyFile",
  "persistHistory",
  'req.method === "DELETE" && path === "/tasks"',
  'path === "/templates"',
  'path === "/workflows"',
  'path === "/workflows/refresh"',
  'path === "/connections"',
  'connectionPresetId',
  'createConnectionCatalog',
  'createWorkflowRegistry',
  'appliedRules'
]) if (!host.includes(marker)) throw new Error(`host feature missing: ${marker}`);
for (const marker of [
  'id: "dsh-comfy-video-studio"',
  'sidebar.footer.action',
  'shell.overlay',
  'remote.sessions.models',
  'sessions.binding',
  'COMFY_VIDEO_PROMPT',
  '等待提示词优化',
  '展开查看',
  '暂无自定义模板',
  '保存为新模板',
  '更新所选',
  '关键帧',
  '工作流预设',
  'ComfyUI 连接',
  '手动输入预设 ID',
  '固定 24 FPS',
  'data-ds-dark-theme',
  '清空已结束',
  'className: "cvs-shell"',
  'prefers-reduced-motion'
]) if (!client.includes(marker)) throw new Error(`client feature missing: ${marker}`);
if (/__[A-Z0-9_]+__/.test(client)) throw new Error("unresolved client placeholder");

for (const mode of ["i2v", "t2v"]) {
  const workflow = JSON.parse(await readFile(join(root, "assets", "workflows", `video_minimax_h3_${mode}.json`), "utf8"));
  for (const node of ["92", "121", "105:9", "105:15", "105:17", "105:91", "105:104", "105:111"]) {
    if (!workflow[node]) throw new Error(`${mode} workflow is missing node ${node}`);
  }
  if (mode === "i2v" && !workflow["114"]) throw new Error("i2v workflow is missing LoadImage node 114");
}

for (const count of [1, 2, 3]) {
  const keyframe = JSON.parse(await readFile(join(root, "assets", "workflows", `video_minimax_h3_keyframe_${count}.json`), "utf8"));
  for (const node of ["2", "9", "11", "12", "13", "14", "15", "19", "21", "27", "28"]) {
    if (!keyframe[node]) throw new Error(`${count}-keyframe workflow is missing node ${node}`);
  }
  for (let index = 0; index < count; index += 1) {
    if (keyframe[String(22 + index)]?.class_type !== "LoadImage") throw new Error(`${count}-keyframe workflow image chain is invalid`);
    if (keyframe[String(30 + index)]?.class_type !== "MiniMaxH3AddImageGuideBackport") throw new Error(`${count}-keyframe workflow guide chain is invalid`);
  }
}

const manifest = JSON.parse(await readFile(join(root, "assets", "workflows", "minimax-h3-default.preset.json"), "utf8"));
if (manifest.id !== "minimax-h3-default") throw new Error("default workflow preset id mismatch");
if (Object.keys(manifest.modes.keyframe.variants).length !== 3) throw new Error("default workflow preset is missing keyframe variants");

console.log("dsh-comfy-video-studio package checks passed");
