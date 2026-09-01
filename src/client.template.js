const React = require("react");
const { createElement: h, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

const PACKAGE_ID = "dsh-comfy-video-studio";
const STYLE_ID = `${PACKAGE_ID}/studio.css`;
const STUDIO_CSS = __STUDIO_CSS__;
const API = "/comfy-video/api";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

const visibility = {
  value: false,
  listeners: new Set(),
  getSnapshot() { return this.value; },
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
  set(next) { this.value = next; for (const listener of this.listeners) listener(); }
};

async function api(path, init) {
  const response = await fetch(`${API}${path}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
  return payload;
}

function jsonInit(method, body) {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function VideoIcon({ size = 20 }) {
  return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
    h("path", { d: "M4.8 5.5h9.4A2.8 2.8 0 0 1 17 8.3v7.4a2.8 2.8 0 0 1-2.8 2.8H4.8A2.8 2.8 0 0 1 2 15.7V8.3a2.8 2.8 0 0 1 2.8-2.8Z", stroke: "currentColor", strokeWidth: 1.7 }),
    h("path", { d: "m17 10 4-2.3v8.6L17 14", stroke: "currentColor", strokeWidth: 1.7, strokeLinejoin: "round" }),
    h("path", { d: "m8.2 9.1 4.5 2.9-4.5 2.9V9.1Z", fill: "currentColor" })
  );
}

function StudioButton({ wide }) {
  return h("button", { type: "button", className: "cvs-launch", "data-wide": wide ? "true" : "false", title: "ComfyUI 工作流", onClick: () => visibility.set(true) },
    h(VideoIcon), wide ? h("span", null, "ComfyUI 工作流") : null
  );
}

function Button({ children, primary, danger, className = "", ...props }) {
  return h("button", { type: "button", className: `cvs-button${primary ? " cvs-primary" : ""}${danger ? " cvs-danger" : ""} ${className}`, ...props }, children);
}

function Field({ label, hint, children }) {
  return h("label", { className: "cvs-field" },
    h("span", { className: "cvs-field-head" }, h("strong", null, label), hint ? h("small", null, hint) : null),
    children
  );
}

function Input({ onChange, ...props }) {
  return h("input", { className: "cvs-input", ...props, onChange: (event) => onChange?.(event.target.value, event) });
}

function Select({ options, value, onChange, placeholder }) {
  return h("select", { className: "cvs-input", value: value ?? "", onChange: (event) => onChange(event.target.value) },
    placeholder ? h("option", { value: "" }, placeholder) : null,
    options.map((item) => {
      const option = typeof item === "string" ? { value: item, label: item } : item;
      return h("option", { key: option.value, value: option.value }, option.label);
    })
  );
}

function PageTitle({ title, description, actions }) {
  return h("div", { className: "cvs-page-title" },
    h("div", null, h("h1", null, title), description ? h("p", null, description) : null),
    actions ? h("div", { className: "cvs-actions" }, actions) : null
  );
}

function Empty({ title, detail, action }) {
  return h("div", { className: "cvs-empty" }, h("div", { className: "cvs-empty-icon" }, h(VideoIcon, { size: 30 })), h("h3", null, title), h("p", null, detail), action);
}

function Toast({ value }) {
  return value ? h("div", { className: "cvs-toast", role: "status" }, value) : null;
}

function CompatibilityReport({ analysis }) {
  if (!analysis) return h("div", { className: "cvs-callout" }, "尚未检测工作流与服务器兼容性。");
  const groups = [
    ["结构问题", analysis.structuralErrors, (item) => item.message],
    ["缺失节点", analysis.nodeHints, (item) => item.hint ? `${item.classType} → ${item.hint.package}（${item.hint.source}）` : `${item.classType} → 未找到可靠包映射`],
    ["缺失模型", analysis.missingModels, (item) => `${item.classType}.${item.inputName}：${item.value}`],
    ["无效选项", analysis.invalidOptions, (item) => `${item.classType}.${item.inputName}：${item.value}`],
    ["连接错误", analysis.connectionErrors, (item) => `节点 ${item.sourceId} → ${item.nodeId}.${item.inputName}：${item.message}`]
  ];
  return h("div", { className: "cvs-report" },
    h("div", { className: `cvs-report-summary ${analysis.ok ? "is-ok" : analysis.status === "unverified" ? "is-warn" : "is-error"}` },
      h("strong", null, analysis.ok ? "兼容性通过" : analysis.status === "unverified" ? "尚未连接服务器验证" : "发现不兼容项"),
      h("span", null, `${analysis.nodeCount} 个节点 · ${analysis.fields.length} 个候选参数 · ${analysis.outputs.length} 个视频输出`)
    ),
    groups.map(([title, items, render]) => Array.isArray(items) && items.length
      ? h("section", { key: title, className: "cvs-finding-group" }, h("h3", null, `${title}（${items.length}）`), h("ul", null, items.map((item, index) => h("li", { key: index }, render(item)))))
      : null)
  );
}

function FieldEditor({ fields, setFields }) {
  const update = (id, patch) => setFields((current) => current.map((field) => field.id === id ? { ...field, ...patch } : field));
  return h("div", { className: "cvs-field-editor" },
    h("div", { className: "cvs-field-editor-head" }, h("span", null, "显示"), h("span", null, "页面标签"), h("span", null, "分组"), h("span", null, "高级"), h("span", null, "顺序")),
    [...fields].sort((a, b) => a.order - b.order).map((field) => h("div", { key: field.id, className: "cvs-field-editor-row" },
      h("input", { type: "checkbox", checked: field.visible, onChange: (event) => update(field.id, { visible: event.target.checked }) }),
      h("div", null, h(Input, { value: field.label, onChange: (value) => update(field.id, { label: value }) }), h("small", null, `${field.id} · ${field.kind}`)),
      h(Input, { value: field.group, onChange: (value) => update(field.id, { group: value }) }),
      h("input", { type: "checkbox", checked: field.advanced, onChange: (event) => update(field.id, { advanced: event.target.checked }) }),
      h(Input, { type: "number", value: field.order, min: 0, onChange: (value) => update(field.id, { order: Number(value) }) })
    ))
  );
}

function LibraryPage({ workflows, onImport, onOpen, onEdit, onDelete }) {
  return h("div", { className: "cvs-page" },
    h(PageTitle, { title: "工作流库", description: "导入 API JSON 后生成可长期保存、可编辑的独立工作页面。", actions: h(Button, { primary: true, onClick: onImport }, "导入工作流") }),
    workflows.length
      ? h("div", { className: "cvs-card-grid" }, workflows.map((workflow) => h("article", { key: workflow.id, className: "cvs-card" },
          h("div", { className: "cvs-card-top" }, h("span", { className: "cvs-badge" }, `${workflow.outputs.length} 个视频输出`), h("code", null, workflow.hash.slice(0, 8))),
          h("h2", null, workflow.name),
          h("p", null, workflow.description || workflow.sourceFileName),
          h("div", { className: "cvs-card-meta" }, `${workflow.fields.filter((item) => item.visible).length} 个页面参数 · ${new Date(workflow.updatedAt).toLocaleString()}`),
          h("div", { className: "cvs-actions" },
            h(Button, { primary: true, onClick: () => onOpen(workflow.id) }, "打开"),
            h(Button, { onClick: () => onEdit(workflow.id) }, "编辑展示"),
            h(Button, { danger: true, onClick: () => onDelete(workflow) }, "删除")
          )
        )))
      : h(Empty, { title: "还没有工作流页面", detail: "上传 ComfyUI 导出的 API JSON，从依赖检测开始。", action: h(Button, { primary: true, onClick: onImport }, "开始导入") })
  );
}

function ImportPage({ connections, onSaved, notify }) {
  const [step, setStep] = useState(1);
  const [connectionId, setConnectionId] = useState(connections.defaultId || connections.presets[0]?.id || "");
  const [file, setFile] = useState(null);
  const [workflow, setWorkflow] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [fields, setFields] = useState([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [primaryOutputNodeId, setPrimaryOutputNodeId] = useState("");
  const [busy, setBusy] = useState(false);

  const inspect = async () => {
    if (!file || !connectionId) return notify("请选择服务器和 API JSON 文件");
    setBusy(true);
    try {
      const text = (await file.text()).replace(/^\uFEFF/, "");
      const parsed = JSON.parse(text);
      const result = await api(`/workflows/inspect?connectionPresetId=${encodeURIComponent(connectionId)}`, { method: "POST", headers: { "content-type": "application/json", "x-file-name": encodeURIComponent(file.name) }, body: text });
      setWorkflow(parsed);
      setAnalysis(result.analysis);
      setFields(result.analysis.fields);
      setPrimaryOutputNodeId(result.analysis.suggestedPrimaryOutputNodeId || "");
      setName(file.name.replace(/\.json$/i, ""));
      setStep(2);
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (!name.trim()) return notify("请输入工作流页面名称");
    setBusy(true);
    try {
      const pageFields = fields.map(({ id, visible, label, group, advanced, order }) => ({ id, visible, label, group, advanced, order }));
      const saved = await api("/workflows", jsonInit("POST", { name: name.trim(), description, sourceFileName: file?.name, workflow, fields: pageFields, primaryOutputNodeId }));
      notify("工作流页面已保存");
      onSaved(saved.id);
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };

  return h("div", { className: "cvs-page" },
    h(PageTitle, { title: "导入工作流", description: "API JSON → 兼容性报告 → 页面参数配置" }),
    h("div", { className: "cvs-steps" }, [1, 2, 3].map((value) => h("div", { key: value, className: step >= value ? "is-active" : "" }, h("span", null, value), ["选择文件", "检查依赖", "配置页面"][value - 1]))),
    step === 1 ? h("section", { className: "cvs-panel" },
      h(Field, { label: "目标 ComfyUI", hint: "导入只用于检测，保存后的工作流仍可切换服务器" }, h(Select, { value: connectionId, onChange: setConnectionId, options: connections.presets.map((item) => ({ value: item.id, label: `${item.name} · ${item.baseUrl}` })) })),
      h(Field, { label: "API JSON 文件", hint: "不支持画布 JSON" }, h("input", { className: "cvs-file", type: "file", accept: ".json,application/json", onChange: (event) => setFile(event.target.files?.[0] || null) })),
      h(Button, { primary: true, disabled: busy, onClick: inspect }, busy ? "解析与检测中…" : "上传并检查")
    ) : null,
    step === 2 ? h("section", { className: "cvs-panel" },
      h(CompatibilityReport, { analysis }),
      h("div", { className: "cvs-actions" }, h(Button, { onClick: () => setStep(1) }, "返回"), h(Button, { primary: true, onClick: () => setStep(3) }, analysis?.ok ? "继续配置" : "仍然保存并配置"))
    ) : null,
    step === 3 ? h("section", { className: "cvs-panel" },
      h("div", { className: "cvs-grid-2" },
        h(Field, { label: "页面名称" }, h(Input, { value: name, onChange: setName })),
        h(Field, { label: "主视频输出" }, h(Select, { value: primaryOutputNodeId, onChange: setPrimaryOutputNodeId, options: analysis.outputs.map((item) => ({ value: item.nodeId, label: `${item.title} · 节点 ${item.nodeId}` })) }))
      ),
      h(Field, { label: "说明" }, h("textarea", { className: "cvs-textarea", value: description, onChange: (event) => setDescription(event.target.value), placeholder: "这个工作流用于什么场景？" })),
      h("h2", null, "参数展示"),
      h("p", { className: "cvs-muted" }, "只允许页面覆盖这里列出的原始常量；连线和隐藏运行时输入不会暴露。"),
      h(FieldEditor, { fields, setFields }),
      h("div", { className: "cvs-actions" }, h(Button, { onClick: () => setStep(2) }, "返回报告"), h(Button, { primary: true, disabled: busy, onClick: save }, busy ? "保存中…" : "保存工作流页面"))
    ) : null
  );
}

function WorkflowEditPage({ workflowId, onSaved, notify }) {
  const [workflow, setWorkflow] = useState(null);
  const [fields, setFields] = useState([]);
  useEffect(() => { api(`/workflows/${encodeURIComponent(workflowId)}`).then((value) => { setWorkflow(value); setFields(value.fields); }, (error) => notify(error.message)); }, [workflowId]);
  if (!workflow) return h("div", { className: "cvs-page" }, "加载中…");
  const save = async () => {
    try {
      await api(`/workflows/${encodeURIComponent(workflowId)}`, jsonInit("PATCH", { name: workflow.name, description: workflow.description, primaryOutputNodeId: workflow.primaryOutputNodeId, fields }));
      notify("参数展示已更新");
      onSaved();
    } catch (error) { notify(error.message); }
  };
  return h("div", { className: "cvs-page" },
    h(PageTitle, { title: "编辑工作流页面", description: workflow.sourceFileName }),
    h("section", { className: "cvs-panel" },
      h("div", { className: "cvs-grid-2" },
        h(Field, { label: "页面名称" }, h(Input, { value: workflow.name, onChange: (value) => setWorkflow((current) => ({ ...current, name: value })) })),
        h(Field, { label: "主视频输出" }, h(Select, { value: workflow.primaryOutputNodeId, onChange: (value) => setWorkflow((current) => ({ ...current, primaryOutputNodeId: value })), options: workflow.outputs.map((item) => ({ value: item.nodeId, label: `${item.title} · 节点 ${item.nodeId}` })) }))
      ),
      h(Field, { label: "说明" }, h("textarea", { className: "cvs-textarea", value: workflow.description, onChange: (event) => setWorkflow((current) => ({ ...current, description: event.target.value })) })),
      h(FieldEditor, { fields, setFields }),
      h(Button, { primary: true, onClick: save }, "保存修改")
    )
  );
}

function DynamicField({ field, value, connectionId, onChange, notify }) {
  const [uploading, setUploading] = useState(false);
  if (["image", "video"].includes(field.kind)) {
    const upload = async (file) => {
      if (!file) return;
      setUploading(true);
      try {
        const result = await api(`/upload?connectionPresetId=${encodeURIComponent(connectionId)}`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) }, body: file });
        onChange(result.subfolder ? `${result.subfolder}/${result.name}` : result.name);
        notify(`${file.name} 已上传到当前 ComfyUI`);
      } catch (error) { notify(error.message); }
      finally { setUploading(false); }
    };
    return h(Field, { label: field.label, hint: value || (field.kind === "video" ? "上传视频" : "上传图片") }, h("input", { className: "cvs-file", type: "file", accept: field.kind === "video" ? "video/*" : "image/*", disabled: uploading, onChange: (event) => upload(event.target.files?.[0]) }));
  }
  if (field.kind === "boolean") return h("label", { className: "cvs-toggle" }, h("input", { type: "checkbox", checked: value === true, onChange: (event) => onChange(event.target.checked) }), h("span", null, field.label));
  if (["enum", "model"].includes(field.kind) && field.options?.length) return h(Field, { label: field.label }, h(Select, { value, onChange, options: field.options }));
  if (field.kind === "textarea") return h(Field, { label: field.label }, h("textarea", { className: "cvs-textarea", value: value ?? "", onChange: (event) => onChange(event.target.value) }));
  if (["integer", "number"].includes(field.kind)) return h(Field, { label: field.label }, h(Input, { type: "number", value: value ?? "", min: field.min ?? undefined, max: field.max ?? undefined, step: field.step ?? (field.kind === "integer" ? 1 : "any"), onChange: (next) => onChange(Number(next)) }));
  return h(Field, { label: field.label }, h(Input, { value: typeof value === "object" ? JSON.stringify(value) : value ?? "", onChange }));
}

function WorkflowRunPage({ workflowId, connections, onTaskCreated, onEdit, notify }) {
  const [workflow, setWorkflow] = useState(null);
  const [connectionId, setConnectionId] = useState(connections.defaultId || "");
  const [analysis, setAnalysis] = useState(null);
  const [values, setValues] = useState({});
  const [outputDirectory, setOutputDirectory] = useState(() => localStorage.getItem(`${PACKAGE_ID}/outputDirectory`) || "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/workflows/${encodeURIComponent(workflowId)}`).then((next) => {
      setWorkflow(next);
      setValues(Object.fromEntries(next.fields.map((field) => [field.id, field.defaultValue])));
    }, (error) => notify(error.message));
  }, [workflowId]);

  const check = async (force = false) => {
    if (!workflow || !connectionId) return;
    setAnalysis(null);
    try {
      const next = await api(`/workflows/${encodeURIComponent(workflow.id)}/compatibility?connectionPresetId=${encodeURIComponent(connectionId)}${force ? "&force=1" : ""}`);
      setAnalysis(next);
      setWorkflow((current) => ({ ...current, fields: next.fields }));
      setValues((current) => Object.fromEntries(next.fields.map((field) => {
        const value = current[field.id];
        const valid = !field.options?.length || field.options.includes(value);
        return [field.id, valid ? value : field.defaultValue];
      })));
    } catch (error) { setAnalysis({ status: "unverified", ok: false, nodeCount: Object.keys(workflow.workflow).length, fields: workflow.fields, outputs: workflow.outputs, structuralErrors: [], nodeHints: [], missingModels: [], invalidOptions: [], connectionErrors: [] }); notify(error.message); }
  };
  useEffect(() => { if (workflow && connectionId) void check(true); }, [workflow?.id, connectionId]);

  if (!workflow) return h("div", { className: "cvs-page" }, "加载工作流…");
  const visible = [...workflow.fields].filter((field) => field.visible).sort((a, b) => a.order - b.order);
  const normal = visible.filter((field) => !field.advanced);
  const advanced = visible.filter((field) => field.advanced);
  const groups = (items) => Object.entries(items.reduce((map, field) => { (map[field.group] ||= []).push(field); return map; }, {}));
  const setValue = (id, value) => setValues((current) => ({ ...current, [id]: value }));
  const selectConnection = (nextId) => {
    setConnectionId(nextId);
    setValues((current) => ({
      ...current,
      ...Object.fromEntries(workflow.fields.filter((field) => ["image", "video"].includes(field.kind)).map((field) => [field.id, ""]))
    }));
    notify("已切换 ComfyUI；上传文件属于原服务器，请重新上传");
  };
  const renderGroups = (items) => groups(items).map(([group, fields]) => h("section", { key: group, className: "cvs-parameter-group" }, h("h2", null, group), h("div", { className: "cvs-form-grid" }, fields.map((field) => h(DynamicField, { key: field.id, field, value: values[field.id], connectionId, onChange: (value) => setValue(field.id, value), notify })))));
  const submit = async () => {
    if (!analysis?.ok) return notify("当前服务器兼容性未通过，不能执行");
    setBusy(true);
    try {
      localStorage.setItem(`${PACKAGE_ID}/outputDirectory`, outputDirectory);
      const task = await api("/tasks", jsonInit("POST", { workflowId: workflow.id, connectionPresetId: connectionId, outputDirectory, values }));
      notify("任务已进入本地调度队列");
      onTaskCreated(task.id);
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const selectedConnection = connections.presets.find((item) => item.id === connectionId);

  return h("div", { className: "cvs-page" },
    h(PageTitle, { title: workflow.name, description: workflow.description || workflow.sourceFileName, actions: h(Button, { onClick: onEdit }, "编辑参数展示") }),
    h("div", { className: "cvs-run-layout" },
      h("main", null,
        renderGroups(normal),
        advanced.length ? h("details", { className: "cvs-panel cvs-advanced" }, h("summary", null, `高级参数（${advanced.length}）`), renderGroups(advanced)) : null
      ),
      h("aside", { className: "cvs-run-side" },
        h("section", { className: "cvs-panel" },
          h(Field, { label: "ComfyUI 服务器" }, h(Select, { value: connectionId, onChange: selectConnection, options: connections.presets.map((item) => ({ value: item.id, label: `${item.name} · 并发 ${item.maxConcurrency}` })) })),
          h("div", { className: "cvs-muted" }, selectedConnection?.baseUrl),
          h(Button, { onClick: () => check(true) }, "重新检测兼容性"),
          h(CompatibilityReport, { analysis })
        ),
        h("section", { className: "cvs-panel" },
          h(Field, { label: "输出目录", hint: "DeepSeek Harness 主机绝对路径" }, h(Input, { value: outputDirectory, placeholder: "D:\\Videos\\ComfyUI", onChange: setOutputDirectory })),
          selectedConnection?.maxConcurrency > 1 ? h("div", { className: "cvs-callout" }, "并发槽只限制插件提交数；标准单 GPU ComfyUI 仍可能串行执行。") : null,
          h(Button, { primary: true, disabled: busy || !analysis?.ok, onClick: submit }, busy ? "创建任务中…" : "加入任务队列")
        )
      )
    )
  );
}

const STATUS_LABELS = { waiting: "本地等待", submitting: "提交中", remote_queued: "远端排队", running: "运行中", finalizing: "收尾", writing: "保存输出", completed: "完成", failed: "失败", cancelled: "取消" };

function TasksPage({ tasks, refresh, notify }) {
  const cancel = async (id) => { try { await api(`/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }); await refresh(); } catch (error) { notify(error.message); } };
  const clear = async () => { try { const result = await api("/tasks", { method: "DELETE" }); notify(`已清理 ${result.removed} 个结束任务`); await refresh(); } catch (error) { notify(error.message); } };
  return h("div", { className: "cvs-page" },
    h(PageTitle, { title: "任务中心", description: "本地 FIFO 队列与 ComfyUI 远端执行状态分开显示。", actions: h(Button, { onClick: clear }, "清理已结束") }),
    tasks.length ? h("div", { className: "cvs-task-list" }, tasks.map((task) => h("article", { key: task.id, className: "cvs-task" },
      h("div", { className: "cvs-task-head" }, h("div", null, h("h2", null, task.workflowName), h("span", null, `${task.connectionName} · ${new Date(task.createdAt).toLocaleString()}`)), h("span", { className: `cvs-status is-${task.status}` }, STATUS_LABELS[task.status] || task.status)),
      h("p", null, task.stage),
      task.progress?.percent != null ? h("div", { className: "cvs-progress" }, h("span", { style: { width: `${task.progress.percent}%` } })) : null,
      task.error ? h("div", { className: "cvs-error" }, task.error) : null,
      task.warning ? h("div", { className: "cvs-callout" }, task.warning) : null,
      task.outputs?.length ? h("div", { className: "cvs-output-grid" }, task.outputs.map((output, index) => h("div", { key: index }, h("video", { src: output.videoUrl, controls: true, playsInline: true }), h("small", null, `节点 ${output.nodeId} · ${output.filename}`)))) : null,
      !TERMINAL.has(task.status) ? h(Button, { danger: true, onClick: () => cancel(task.id) }, task.status === "running" ? "中断服务器当前任务" : "取消任务") : null
    ))) : h(Empty, { title: "暂无任务", detail: "从任意工作流页面提交后，任务会出现在这里。" })
  );
}

function deviceSummary(stats) {
  const device = stats?.devices?.[0];
  if (!device) return "未返回设备信息";
  const total = Number(device.vram_total || 0) / 1024 / 1024 / 1024;
  const free = Number(device.vram_free || 0) / 1024 / 1024 / 1024;
  return `${device.name || device.type || "GPU"} · 显存 ${free.toFixed(1)} / ${total.toFixed(1)} GB 可用`;
}

function ServersPage({ catalog, refreshCatalog, notify }) {
  const empty = { id: "", name: "", baseUrl: "", allowSelfSigned: false, maxConcurrency: 1, makeDefault: false, mutable: true };
  const [draft, setDraft] = useState({ ...empty });
  const [health, setHealth] = useState({});
  const [busy, setBusy] = useState(false);
  const test = async (id, deep = false) => {
    if (!id) return;
    setHealth((current) => ({ ...current, [id]: { loading: true } }));
    try { const result = await api(`/connections/${encodeURIComponent(id)}/health${deep ? "?deep=1" : ""}`); setHealth((current) => ({ ...current, [id]: result })); }
    catch (error) { setHealth((current) => ({ ...current, [id]: { ok: false, status: "offline", error: error.message, checkedAt: Date.now() } })); }
  };
  useEffect(() => {
    for (const item of catalog.presets) void test(item.id);
    const timer = setInterval(() => { for (const item of catalog.presets) void test(item.id); }, 15000);
    return () => clearInterval(timer);
  }, [catalog.presets.map((item) => item.id).join("|")]);
  const save = async () => {
    if (!draft.name.trim() || !draft.baseUrl.trim()) return notify("请填写连接名称和地址");
    setBusy(true);
    try {
      const path = draft.id ? `/connections/${encodeURIComponent(draft.id)}` : "/connections";
      const result = await api(path, jsonInit(draft.id ? "PATCH" : "POST", draft));
      notify(draft.id ? "服务器已更新" : "服务器已保存");
      await refreshCatalog();
      setDraft(result.preset ? { ...result.preset, makeDefault: result.catalog.defaultId === result.preset.id } : { ...empty });
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const setConcurrency = async (item, value) => {
    try { await api(`/connections/${encodeURIComponent(item.id)}/queue`, jsonInit("PATCH", { maxConcurrency: Number(value) })); await refreshCatalog(); notify(`并发已调整为 ${value}`); }
    catch (error) { notify(error.message); }
  };
  const remove = async (item) => {
    if (!window.confirm(`删除服务器“${item.name}”？`)) return;
    try { await api(`/connections/${encodeURIComponent(item.id)}`, { method: "DELETE" }); await refreshCatalog(); notify("服务器已删除"); }
    catch (error) { notify(error.message); }
  };
  return h("div", { className: "cvs-page" },
    h(PageTitle, { title: "服务器管理", description: "状态轮询使用轻量接口；节点清单仅在深度检测、导入和执行前刷新。" }),
    h("div", { className: "cvs-server-grid" },
      h("section", { className: "cvs-server-list" }, catalog.presets.map((item) => {
        const state = health[item.id] || {};
        return h("article", { key: item.id, className: "cvs-card" },
          h("div", { className: "cvs-task-head" }, h("h2", null, item.name), h("span", { className: `cvs-status is-${state.status || "unknown"}` }, state.loading ? "检测中" : state.status === "online" ? "在线" : state.status === "degraded" ? "降级" : "离线")),
          h("code", null, item.baseUrl),
          state.ok ? h("div", { className: "cvs-server-health" }, h("span", null, `${state.latencyMs}ms`), h("span", null, deviceSummary(state.stats)), h("span", null, state.queue ? `远端队列：运行 ${state.queue.running} / 等待 ${state.queue.pending}` : state.queueError)) : h("div", { className: "cvs-error" }, state.error || "尚未检测"),
          h(Field, { label: "插件活动槽", hint: "1–3；同一单 GPU 后端通常仍串行" }, h(Select, { value: String(item.maxConcurrency), onChange: (value) => setConcurrency(item, value), options: ["1", "2", "3"] })),
          h("div", { className: "cvs-actions" }, h(Button, { onClick: () => test(item.id, true) }, "深度检测"), item.mutable ? h(Button, { onClick: () => setDraft({ ...item, makeDefault: catalog.defaultId === item.id }) }, "编辑") : null, item.mutable ? h(Button, { danger: true, onClick: () => remove(item) }, "删除") : null)
        );
      })),
      h("section", { className: "cvs-panel" },
        h("h2", null, draft.id ? "编辑服务器" : "新增服务器"),
        h(Field, { label: "名称" }, h(Input, { value: draft.name, onChange: (value) => setDraft((current) => ({ ...current, name: value })) })),
        h(Field, { label: "ComfyUI 地址" }, h(Input, { type: "url", value: draft.baseUrl, placeholder: "https://example.com:8188", onChange: (value) => setDraft((current) => ({ ...current, baseUrl: value })) })),
        h(Field, { label: "默认并发" }, h(Select, { value: String(draft.maxConcurrency), onChange: (value) => setDraft((current) => ({ ...current, maxConcurrency: Number(value) })), options: ["1", "2", "3"] })),
        h("label", { className: "cvs-toggle" }, h("input", { type: "checkbox", checked: draft.allowSelfSigned, onChange: (event) => setDraft((current) => ({ ...current, allowSelfSigned: event.target.checked })) }), h("span", null, "允许自签名 HTTPS 证书")),
        h("label", { className: "cvs-toggle" }, h("input", { type: "checkbox", checked: draft.makeDefault, onChange: (event) => setDraft((current) => ({ ...current, makeDefault: event.target.checked })) }), h("span", null, "设为默认服务器")),
        h("div", { className: "cvs-actions" }, h(Button, { primary: true, disabled: busy, onClick: save }, busy ? "保存中…" : "保存"), h(Button, { onClick: () => setDraft({ ...empty }) }, "清空"))
      )
    )
  );
}

function StudioOverlay() {
  const visible = useSyncExternalStore(visibility.subscribe.bind(visibility), visibility.getSnapshot.bind(visibility));
  const [page, setPage] = useState("library");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(null);
  const [workflows, setWorkflows] = useState([]);
  const [connections, setConnections] = useState({ defaultId: "", presets: [] });
  const [tasks, setTasks] = useState([]);
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);
  const notify = (message) => { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), 4000); };
  const refreshWorkflows = () => api("/workflows").then(setWorkflows);
  const refreshConnections = () => api("/connections").then((value) => { setConnections(value); return value; });
  const refreshTasks = () => api("/tasks").then(setTasks);

  useEffect(() => {
    if (!visible) return;
    Promise.all([refreshWorkflows(), refreshConnections(), refreshTasks()]).catch((error) => notify(error.message));
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => void refreshTasks().catch(() => {}), 2000);
    return () => clearInterval(timer);
  }, [visible]);
  if (!visible) return null;

  const openWorkflow = (id) => { setSelectedWorkflowId(id); setPage("workflow"); };
  const editWorkflow = (id) => { setSelectedWorkflowId(id); setPage("edit"); };
  const removeWorkflow = async (workflow) => {
    if (!window.confirm(`永久删除工作流页面“${workflow.name}”？历史任务不受影响。`)) return;
    try { await api(`/workflows/${encodeURIComponent(workflow.id)}`, { method: "DELETE" }); await refreshWorkflows(); notify("工作流页面已删除"); }
    catch (error) { notify(error.message); }
  };
  const navItems = [["library", "工作流库"], ["import", "导入"], ["tasks", "任务中心"], ["servers", "服务器"]];

  let content;
  if (page === "library") content = h(LibraryPage, { workflows, onImport: () => setPage("import"), onOpen: openWorkflow, onEdit: editWorkflow, onDelete: removeWorkflow });
  else if (page === "import") content = h(ImportPage, { connections, notify, onSaved: async (id) => { await refreshWorkflows(); openWorkflow(id); } });
  else if (page === "workflow") content = h(WorkflowRunPage, { workflowId: selectedWorkflowId, connections, notify, onEdit: () => editWorkflow(selectedWorkflowId), onTaskCreated: async () => { await refreshTasks(); setPage("tasks"); } });
  else if (page === "edit") content = h(WorkflowEditPage, { workflowId: selectedWorkflowId, notify, onSaved: async () => { await refreshWorkflows(); openWorkflow(selectedWorkflowId); } });
  else if (page === "tasks") content = h(TasksPage, { tasks, refresh: refreshTasks, notify });
  else content = h(ServersPage, { catalog: connections, refreshCatalog: refreshConnections, notify });

  return h("div", { className: "cvs-overlay", role: "dialog", "aria-modal": true, "aria-label": "ComfyUI 动态工作流工作台" },
    h("aside", { className: "cvs-nav" },
      h("div", { className: "cvs-brand" }, h(VideoIcon, { size: 24 }), h("div", null, h("strong", null, "ComfyUI Studio"), h("small", null, "Dynamic workflows"))),
      h("nav", null, navItems.map(([id, label]) => h("button", { key: id, className: page === id || id === "library" && ["workflow", "edit"].includes(page) ? "is-active" : "", onClick: () => setPage(id) }, label))),
      h("div", { className: "cvs-nav-spacer" }),
      h("button", { onClick: () => visibility.set(false) }, "关闭工作台")
    ),
    h("div", { className: "cvs-content" }, content),
    h(Toast, { value: toast })
  );
}

const inject = ["slots"];

function installStyles(ctx) {
  ctx.effect(() => {
    document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)?.remove();
    const tag = document.createElement("style");
    tag.dataset.pluginCss = STYLE_ID;
    tag.textContent = STUDIO_CSS;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, `${PACKAGE_ID}: studio styles`);
}

function apply(ctx) {
  installStyles(ctx);
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "comfy-video-studio", order: 45, label: "ComfyUI 工作流" }, StudioButton));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "comfy-video-studio", order: 900 }, StudioOverlay));
}
