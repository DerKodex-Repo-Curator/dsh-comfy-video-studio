import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  analyzeWorkflow,
  applyWorkflowValues,
  createWorkflowRegistry,
  parseApiWorkflow
} from "../src/workflow-presets.js";

const workflow = {
  "1": { class_type: "LoadImage", inputs: { image: "example.png" }, _meta: { title: "参考图" } },
  "2": { class_type: "UNETLoader", inputs: { unet_name: "missing.safetensors", weight_dtype: "default" } },
  "3": { class_type: "ImageToVideo", inputs: { image: ["1", 0], model: ["2", 0], prompt: "hello", steps: 6, enabled: true } },
  "4": { class_type: "SaveVideo", inputs: { video: ["3", 0], filename_prefix: "video/test" }, _meta: { title: "最终视频" } }
};

const objectInfo = {
  LoadImage: { input: { required: { image: [["example.png"], { image_upload: true }] } }, output: ["IMAGE"], category: "image" },
  UNETLoader: { input: { required: { unet_name: [[], {}], weight_dtype: [["default"], {}] } }, output: ["MODEL"], category: "model/loaders" },
  ImageToVideo: { input: { required: { image: ["IMAGE", {}], model: ["MODEL", {}], prompt: ["STRING", { multiline: true }], steps: ["INT", { min: 1, max: 100 }], enabled: ["BOOLEAN", {}] } }, output: ["VIDEO"] },
  SaveVideo: { input: { required: { video: ["VIDEO", {}], filename_prefix: ["STRING", {}] } }, output: ["VIDEO"], output_node: true, category: "video" }
};

test("API JSON format rejects canvas exports", () => {
  assert.throws(() => parseApiWorkflow({ nodes: [], version: 1 }), /画布 JSON/);
  assert.equal(Object.keys(parseApiWorkflow(workflow)).length, 4);
});

test("runtime analysis separates uploads, models, fields and outputs", () => {
  const analysis = analyzeWorkflow(workflow, objectInfo);
  assert.equal(analysis.nodeCount, 4);
  assert.equal(analysis.outputs[0].nodeId, "4");
  assert.equal(analysis.suggestedPrimaryOutputNodeId, "4");
  assert.equal(analysis.fields.find((field) => field.id === "1.image").kind, "image");
  assert.equal(analysis.missingModels[0].value, "missing.safetensors");
  assert.equal(analysis.invalidOptions.length, 0, "upload placeholders must not be reported as invalid model/enum values");
  assert.equal(analysis.fields.find((field) => field.id === "3.prompt").kind, "textarea");
});

test("typed boundary and dangling source errors are distinct", () => {
  const wrongType = structuredClone(workflow);
  objectInfo.LoadImage.output = ["MASK"];
  const typed = analyzeWorkflow(wrongType, objectInfo);
  assert.equal(typed.connectionErrors[0].sourceType, "MASK");
  objectInfo.LoadImage.output = ["IMAGE"];
  const dangling = structuredClone(workflow);
  dangling["3"].inputs.image = ["999", 0];
  assert.match(analyzeWorkflow(dangling, objectInfo).structuralErrors[0].message, /不存在/);
});

test("only declared field bindings can modify a workflow", () => {
  const analysis = analyzeWorkflow(workflow, objectInfo);
  const fields = analysis.fields.filter((field) => ["3.prompt", "3.steps"].includes(field.id));
  const configured = applyWorkflowValues(workflow, fields, { "3.prompt": "new prompt", "3.steps": 12, "4.filename_prefix": "hijack" });
  assert.equal(configured["3"].inputs.prompt, "new prompt");
  assert.equal(configured["3"].inputs.steps, 12);
  assert.equal(configured["4"].inputs.filename_prefix, "video/test");
});

test("workflow registry persists page definitions and supports edit/delete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-workflow-registry-"));
  try {
    const registry = createWorkflowRegistry({ directory });
    await registry.load();
    const analysis = analyzeWorkflow(workflow, objectInfo);
    const saved = await registry.save({ name: "Dynamic test", workflow, fields: analysis.fields, primaryOutputNodeId: "4", sourceFileName: "test-api.json" });
    assert.equal(registry.list().length, 1);
    assert.equal(registry.get(saved.id).workflow["3"].inputs.prompt, "hello");
    const updated = await registry.update(saved.id, { name: "Renamed", fields: saved.fields.map((field) => ({ ...field, visible: field.id === "3.prompt" })) });
    assert.equal(updated.name, "Renamed");
    assert.equal(updated.fields.filter((field) => field.visible).length, 1);
    await registry.remove(saved.id);
    assert.equal(registry.list().length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the discovered 36-node production workflow is parsed when present", () => {
  const filename = "D:\\workspace\\Others\\郎哥项目\\comfy-ui视频生成\\comfyui工作流\\人物替换_文案提取_TTS口播一体版_动态时长_1K竖屏_API.json";
  if (!existsSync(filename)) return;
  const parsed = parseApiWorkflow(readFileSync(filename));
  const analysis = analyzeWorkflow(parsed);
  assert.equal(analysis.nodeCount, 36);
  assert.deepEqual(analysis.outputs.map((item) => item.nodeId), ["37", "45"]);
  assert.equal(analysis.suggestedPrimaryOutputNodeId, "45");
  assert.equal(analysis.fields.find((field) => field.id === "1.image").kind, "image");
  assert.equal(analysis.fields.find((field) => field.id === "2.file").kind, "video");
  assert.equal(analysis.fields.find((field) => field.id === "48.switch").kind, "boolean");
});
