import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export const WORKFLOW_SCHEMA_VERSION = 1;

const TRUSTED_NODE_HINTS = Object.freeze({
  LangGeReferenceVideoPlan: Object.freeze({ package: "ComfyUI-LangGe-DynamicVideo", source: "郎哥项目随附自定义节点" }),
  LangGeWanAnimate2Dynamic: Object.freeze({ package: "ComfyUI-LangGe-DynamicVideo", source: "郎哥项目随附自定义节点" }),
  LatentSyncNode: Object.freeze({ package: "ComfyUI-LatentSyncWrapper", source: "ComfyUI-LatentSyncWrapper" })
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isConnection(value, workflow = null) {
  return Array.isArray(value)
    && value.length === 2
    && (typeof value[0] === "string" || Number.isInteger(value[0]))
    && Number.isInteger(value[1])
    && (!workflow || Object.hasOwn(workflow, String(value[0])));
}

export function parseApiWorkflow(input) {
  let value = input;
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    try {
      value = JSON.parse(value.replace(/^\uFEFF/, ""));
    } catch {
      throw new Error("工作流文件不是有效 JSON");
    }
  }
  if (!plainObject(value)) throw new Error("工作流必须是以节点 ID 为顶层键的 API JSON 对象");
  if (Array.isArray(value.nodes) || plainObject(value.extra) || plainObject(value.state)) {
    throw new Error("检测到 ComfyUI 画布 JSON；请使用“导出（API 格式）”重新导出后上传");
  }
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error("工作流不包含任何节点");
  for (const [nodeId, node] of entries) {
    if (!plainObject(node) || typeof node.class_type !== "string" || !plainObject(node.inputs)) {
      throw new Error(`节点 ${nodeId} 缺少 class_type 或 inputs；只支持 API JSON`);
    }
  }
  return clone(value);
}

export function workflowHash(workflow) {
  return createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
}

function descriptorFor(schema, inputName) {
  return schema?.input?.required?.[inputName] ?? schema?.input?.optional?.[inputName] ?? null;
}

function descriptorType(descriptor) {
  if (!Array.isArray(descriptor)) return null;
  return typeof descriptor[0] === "string" ? descriptor[0] : Array.isArray(descriptor[0]) ? "COMBO" : null;
}

function descriptorMeta(descriptor) {
  return plainObject(descriptor?.[1]) ? descriptor[1] : {};
}

function descriptorOptions(descriptor) {
  if (Array.isArray(descriptor?.[0])) return descriptor[0];
  if (descriptor?.[0] === "COMBO" && Array.isArray(descriptor?.[1]?.options)) return descriptor[1].options;
  return null;
}

function isHiddenInput(schema, inputName) {
  return Boolean(schema?.input?.hidden && Object.hasOwn(schema.input.hidden, inputName));
}

function inferFieldKind({ node, inputName, value, descriptor }) {
  const meta = descriptorMeta(descriptor);
  if (meta.image_upload || node.class_type === "LoadImage" && inputName === "image") return "image";
  if (meta.video_upload || node.class_type === "LoadVideo" && ["file", "video"].includes(inputName)) return "video";
  const options = descriptorOptions(descriptor);
  if (options) return "enum";
  const runtimeType = descriptorType(descriptor);
  if (runtimeType === "BOOLEAN" || typeof value === "boolean") return "boolean";
  if (runtimeType === "INT" || Number.isInteger(value)) return "integer";
  if (runtimeType === "FLOAT" || typeof value === "number") return "number";
  if (runtimeType === "STRING" || typeof value === "string") return meta.multiline ? "textarea" : "text";
  if (value === null) return "text";
  return "json";
}

function isModelField(schema, inputName) {
  const category = String(schema?.category || "").toLowerCase();
  if (category.includes("model/loaders")) return true;
  return /^(ckpt_name|unet_name|model_name|vae_name|clip_name|lora_name|control_net_name)$/i.test(inputName);
}

function suggestedVisible(kind, inputName, meta) {
  if (["image", "video", "boolean"].includes(kind)) return true;
  if (meta.multiline) return true;
  return /(prompt|text|value|switch|voice|speed|duration|seconds)$/i.test(inputName);
}

function normalizeField(field, fallback, index) {
  const source = plainObject(field) ? field : {};
  return {
    ...fallback,
    visible: source.visible === undefined ? fallback.visible : source.visible === true,
    label: String(source.label || fallback.label).trim().slice(0, 160),
    group: String(source.group || fallback.group).trim().slice(0, 160),
    advanced: source.advanced === undefined ? fallback.advanced : source.advanced === true,
    order: Number.isFinite(Number(source.order)) ? Math.max(0, Math.round(Number(source.order))) : index
  };
}

export function analyzeWorkflow(workflowInput, objectInfo = null, configuredFields = null) {
  const workflow = parseApiWorkflow(workflowInput);
  const structuralErrors = [];
  const connectionErrors = [];
  const invalidOptions = [];
  const missingModels = [];
  const missingNodes = [];
  const fields = [];
  const outputs = [];
  const configured = new Map((Array.isArray(configuredFields) ? configuredFields : []).map((field) => [field.id, field]));
  let order = 0;

  for (const [nodeId, node] of Object.entries(workflow)) {
    const schema = objectInfo?.[node.class_type] ?? null;
    if (objectInfo && !schema && !missingNodes.includes(node.class_type)) missingNodes.push(node.class_type);
    if (node.class_type === "SaveVideo") {
      outputs.push({ nodeId, classType: node.class_type, title: String(node._meta?.title || `SaveVideo ${nodeId}`) });
    }
    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && Number.isInteger(value[1])) {
        const sourceId = String(value[0]);
        if (!Object.hasOwn(workflow, sourceId)) {
          structuralErrors.push({ nodeId, inputName, message: `连接引用了不存在的源节点 ${sourceId}` });
          continue;
        }
        if (objectInfo && schema && objectInfo[workflow[sourceId].class_type]) {
          const sourceSchema = objectInfo[workflow[sourceId].class_type];
          const sourceType = sourceSchema.output?.[value[1]];
          const targetDescriptor = descriptorFor(schema, inputName);
          const targetType = descriptorType(targetDescriptor);
          if (sourceType === undefined) {
            connectionErrors.push({ nodeId, inputName, sourceId, outputIndex: value[1], message: `源节点 ${sourceId} 没有第 ${value[1]} 个输出` });
          } else if (targetType && sourceType && targetType !== sourceType && !["*", "ANY"].includes(targetType)) {
            connectionErrors.push({ nodeId, inputName, sourceId, outputIndex: value[1], sourceType, targetType, message: `${sourceType} 不能连接到 ${targetType}` });
          }
        }
        continue;
      }
      if (!["string", "number", "boolean"].includes(typeof value) && value !== null) continue;
      if (schema && isHiddenInput(schema, inputName)) continue;
      const descriptor = descriptorFor(schema, inputName);
      const meta = descriptorMeta(descriptor);
      const options = descriptorOptions(descriptor);
      let kind = inferFieldKind({ node, inputName, value, descriptor });
      const model = isModelField(schema, inputName);
      if (model) kind = "model";
      if (objectInfo && schema && options && typeof value === "string" && !options.includes(value)) {
        const finding = { nodeId, classType: node.class_type, inputName, value, available: options.slice(0, 200) };
        if (model) missingModels.push(finding);
        else if (!["image", "video"].includes(kind)) invalidOptions.push(finding);
      }
      const title = String(node._meta?.title || schema?.display_name || node.class_type);
      const visible = suggestedVisible(kind, inputName, meta);
      const fallback = {
        id: `${nodeId}.${inputName}`,
        nodeId,
        classType: node.class_type,
        inputName,
        label: `${title} · ${inputName}`,
        group: title,
        kind,
        defaultValue: clone(value),
        required: Boolean(schema?.input?.required && Object.hasOwn(schema.input.required, inputName)),
        visible,
        advanced: !visible,
        order,
        options: options ? clone(options) : [],
        min: Number.isFinite(Number(meta.min)) ? Number(meta.min) : null,
        max: Number.isFinite(Number(meta.max)) ? Number(meta.max) : null,
        step: Number.isFinite(Number(meta.step)) ? Number(meta.step) : null,
        multiline: meta.multiline === true,
        model
      };
      fields.push(normalizeField(configured.get(fallback.id), fallback, order));
      order += 1;
    }
  }

  if (outputs.length === 0) structuralErrors.push({ message: "没有找到 SaveVideo 输出节点；第一版只支持视频工作流" });
  const nodeHints = missingNodes.map((classType) => ({ classType, hint: TRUSTED_NODE_HINTS[classType] ?? null }));
  const ok = Boolean(objectInfo)
    && structuralErrors.length === 0
    && missingNodes.length === 0
    && missingModels.length === 0
    && invalidOptions.length === 0
    && connectionErrors.length === 0;
  return {
    ok,
    status: objectInfo ? (ok ? "compatible" : "incompatible") : "unverified",
    nodeCount: Object.keys(workflow).length,
    hash: workflowHash(workflow),
    fields,
    outputs,
    suggestedPrimaryOutputNodeId: outputs.at(-1)?.nodeId ?? null,
    structuralErrors,
    missingNodes,
    missingModels,
    invalidOptions,
    connectionErrors,
    nodeHints
  };
}

function coerceFieldValue(field, value) {
  if (value === undefined) return clone(field.defaultValue);
  if (field.kind === "boolean") return value === true || value === "true";
  if (field.kind === "integer") {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) throw new Error(`${field.label} 必须是整数`);
    if (field.min != null && number < field.min) throw new Error(`${field.label} 不能小于 ${field.min}`);
    if (field.max != null && number > field.max) throw new Error(`${field.label} 不能大于 ${field.max}`);
    return number;
  }
  if (field.kind === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${field.label} 必须是数字`);
    if (field.min != null && number < field.min) throw new Error(`${field.label} 不能小于 ${field.min}`);
    if (field.max != null && number > field.max) throw new Error(`${field.label} 不能大于 ${field.max}`);
    return number;
  }
  if (["enum", "model"].includes(field.kind) && field.options.length > 0 && !field.options.includes(value)) {
    throw new Error(`${field.label} 的值不在当前服务器可选项中`);
  }
  if (field.kind === "json") {
    if (plainObject(value) || Array.isArray(value)) return clone(value);
    try { return JSON.parse(String(value)); } catch { throw new Error(`${field.label} 不是有效 JSON`); }
  }
  return String(value ?? "");
}

export function applyWorkflowValues(workflowInput, fields, values = {}) {
  const workflow = parseApiWorkflow(workflowInput);
  for (const field of Array.isArray(fields) ? fields : []) {
    const node = workflow[field.nodeId];
    if (!node?.inputs || !Object.hasOwn(node.inputs, field.inputName)) throw new Error(`参数绑定失效：${field.id}`);
    node.inputs[field.inputName] = coerceFieldValue(field, values[field.id]);
  }
  return workflow;
}

function safeDirectory(base, id) {
  const root = resolve(base);
  const target = resolve(root, id);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || rel.includes(":")) throw new Error("工作流 ID 越出存储目录");
  return target;
}

async function atomicWrite(filename, value) {
  await mkdir(dirname(filename), { recursive: true });
  const temporary = `${filename}.partial-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filename);
}

function publicWorkflow(record, includeWorkflow = false) {
  return { ...clone(record.definition), ...(includeWorkflow ? { workflow: clone(record.workflow) } : {}) };
}

export function createWorkflowRegistry({ directory, logger }) {
  const root = resolve(directory);
  const records = new Map();

  async function load() {
    records.clear();
    let entries = [];
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    for (const entry of entries.filter((item) => item.isDirectory())) {
      try {
        const folder = safeDirectory(root, entry.name);
        const definition = JSON.parse(await readFile(resolve(folder, "definition.json"), "utf8"));
        const workflow = parseApiWorkflow(await readFile(resolve(folder, "workflow.json")));
        if (definition.schemaVersion !== WORKFLOW_SCHEMA_VERSION || definition.id !== entry.name) throw new Error("定义版本或 ID 无效");
        const analysis = analyzeWorkflow(workflow, null, definition.fields);
        definition.fields = analysis.fields;
        definition.outputs = analysis.outputs;
        definition.hash = workflowHash(workflow);
        records.set(entry.name, { definition, workflow });
      } catch (error) {
        logger?.warn?.(`[dsh-comfy-video-studio] ignored workflow ${entry.name}: ${error.message}`);
      }
    }
    return list();
  }

  function list() {
    return [...records.values()].map((record) => publicWorkflow(record)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function get(id) {
    const record = records.get(String(id || ""));
    if (!record) throw new Error("工作流不存在");
    return publicWorkflow(record, true);
  }

  async function save(payload) {
    const workflow = parseApiWorkflow(payload?.workflow);
    const baseAnalysis = analyzeWorkflow(workflow);
    const name = String(payload?.name || "").trim();
    if (!name) throw new Error("工作流名称不能为空");
    if (name.length > 120) throw new Error("工作流名称不能超过 120 个字符");
    const id = String(payload?.id || `workflow-${randomUUID()}`).trim();
    if (!/^[a-z0-9][a-z0-9._-]{2,95}$/i.test(id)) throw new Error("工作流 ID 无效");
    if (records.has(id)) throw new Error("工作流 ID 已存在");
    const configuredAnalysis = analyzeWorkflow(workflow, null, payload?.fields);
    const primaryOutputNodeId = String(payload?.primaryOutputNodeId || configuredAnalysis.suggestedPrimaryOutputNodeId || "");
    if (!configuredAnalysis.outputs.some((item) => item.nodeId === primaryOutputNodeId)) throw new Error("主视频输出节点无效");
    const now = Date.now();
    const definition = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id,
      name,
      description: String(payload?.description || "").trim().slice(0, 500),
      sourceFileName: String(payload?.sourceFileName || "workflow-api.json").split(/[\\/]/).pop().slice(0, 240),
      hash: baseAnalysis.hash,
      fields: configuredAnalysis.fields,
      outputs: configuredAnalysis.outputs,
      primaryOutputNodeId,
      createdAt: now,
      updatedAt: now
    };
    const folder = safeDirectory(root, id);
    await mkdir(root, { recursive: true });
    await mkdir(folder, { recursive: false });
    try {
      await atomicWrite(resolve(folder, "workflow.json"), workflow);
      await atomicWrite(resolve(folder, "definition.json"), definition);
    } catch (error) {
      await rm(folder, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    records.set(id, { definition, workflow });
    return get(id);
  }

  async function update(id, payload) {
    const record = records.get(String(id || ""));
    if (!record) throw new Error("工作流不存在");
    const analysis = analyzeWorkflow(record.workflow, null, payload?.fields ?? record.definition.fields);
    const primaryOutputNodeId = String(payload?.primaryOutputNodeId ?? record.definition.primaryOutputNodeId);
    if (!analysis.outputs.some((item) => item.nodeId === primaryOutputNodeId)) throw new Error("主视频输出节点无效");
    const name = String(payload?.name ?? record.definition.name).trim();
    if (!name || name.length > 120) throw new Error("工作流名称无效");
    record.definition = {
      ...record.definition,
      name,
      description: String(payload?.description ?? record.definition.description).trim().slice(0, 500),
      fields: analysis.fields,
      outputs: analysis.outputs,
      primaryOutputNodeId,
      updatedAt: Date.now()
    };
    await atomicWrite(resolve(safeDirectory(root, record.definition.id), "definition.json"), record.definition);
    return get(record.definition.id);
  }

  async function remove(id) {
    const key = String(id || "");
    if (!records.has(key)) throw new Error("工作流不存在");
    await rm(safeDirectory(root, key), { recursive: true, force: false });
    records.delete(key);
    return { removed: 1 };
  }

  return { load, list, get, save, update, remove };
}
