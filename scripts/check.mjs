import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const patch = await readFile(join(root, "cordis.patch.yml"), "utf8");
const host = await readFile(join(root, "lib", "index.js"), "utf8");
const workflows = await readFile(join(root, "lib", "workflow-presets.js"), "utf8");
const client = await readFile(join(root, "lib", "client.js"), "utf8");

for (const file of ["lib/index.js", "lib/workflow-presets.js", "lib/client.js", "README.md", "README.en.md"]) await access(join(root, file));
if (pkg.name !== "dsh-comfy-video-studio" || pkg.version !== "0.8.0") throw new Error("package identity/version mismatch");
if (pkg.files?.includes("assets/workflows")) throw new Error("fixed workflow assets must not ship in the dynamic studio");
if (pkg.scripts?.prepack !== "npm run build && npm run check") throw new Error("prepack must build and validate");
if (!patch.includes("maxWorkflowMb: 5")) throw new Error("bundle patch must configure workflow upload limit");

for (const marker of [
  'path === "/workflows/inspect"',
  'path === "/workflows"',
  'path === "/tasks"',
  'connectionQueueMatch',
  'inspectCompatibility',
  'dispatchConnection',
  'status: "waiting"',
  'status: "remote_queued"',
  'workflowSnapshot',
  'primaryOutputNodeId',
  'videoDescriptors',
  'Readable.fromWeb',
  'content-range'
]) if (!host.includes(marker)) throw new Error(`host feature missing: ${marker}`);

for (const marker of [
  "parseApiWorkflow",
  "analyzeWorkflow",
  "applyWorkflowValues",
  "createWorkflowRegistry",
  "TRUSTED_NODE_HINTS",
  "missingModels",
  "connectionErrors",
  "suggestedPrimaryOutputNodeId",
  "video_upload",
  "image_upload"
]) if (!workflows.includes(marker)) throw new Error(`workflow feature missing: ${marker}`);

for (const marker of [
  'id: "comfy-video-studio"',
  'sidebar.footer.action',
  'shell.overlay',
  '工作流库',
  '导入工作流',
  '任务中心',
  '服务器管理',
  '编辑工作流页面',
  'CompatibilityReport',
  'FieldEditor',
  'DynamicField',
  '并发槽只限制插件提交数',
  'const inject = ["slots"]',
  'data-plugin-css'
]) if (!client.includes(marker)) throw new Error(`client feature missing: ${marker}`);
if (/__[A-Z0-9_]+__/.test(client)) throw new Error("client bundle contains unresolved placeholders");
for (const removed of ["ctx.llm.stream", 'path === "/optimize"', 'path === "/templates"', "minimax-h3-default", "person_replace"]) {
  if (host.includes(removed) || client.includes(removed)) throw new Error(`removed fixed-template feature still present: ${removed}`);
}

console.log("dsh-comfy-video-studio dynamic workflow package checks passed");
