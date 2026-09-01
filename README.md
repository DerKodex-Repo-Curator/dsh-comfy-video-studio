# dsh-comfy-video-studio

DeepSeek Harness 的 ComfyUI 动态视频工作流插件。它不再内置 MiniMax、Wan 或其他模型模板，而是把任意 **ComfyUI API JSON** 导入为可长期保存的独立工作页面。

## 主要能力

- 导入 API JSON，自动识别常量参数、图片/视频上传、枚举、模型和 `SaveVideo` 输出。
- 使用目标 ComfyUI 的 `/object_info` 检查缺失节点、模型、无效枚举和端口类型。
- 保存、重命名、删除工作流页面，并编辑字段的显示、标签、分组、顺序和高级参数标记。
- 动态保存多个 ComfyUI 服务器，检测延迟、设备、显存和远端队列。
- 每台服务器独立设置 1–3 个插件活动槽；超额任务保留在本地 FIFO 队列。
- 保存所有视频输出，指定其中一个作为任务主预览。
- 持久化工作流、连接、任务与队列；Harness 重启后恢复等待任务和已有 `prompt_id` 的监控。

> 标准单 GPU ComfyUI 通常仍会串行执行远端 prompt。活动槽 2–3 控制插件提前提交的数量，不保证 GPU 真正并行。

## 工作流格式

只支持“导出（API 格式）”产生的 JSON：顶层键是节点 ID，每个节点包含 `class_type` 和 `inputs`。画布 JSON 会被拒绝并提示重新导出。

导入流程：

1. 在“服务器管理”中添加或检查目标 ComfyUI。
2. 在“导入”页上传 API JSON。
3. 查看运行时兼容性报告。
4. 选择主 `SaveVideo` 输出和需要显示的参数。
5. 保存并打开动态工作流页面。

缺失依赖只会阻止执行，不会阻止保存工作流页面。插件不会联网查询或自动安装节点、模型。

## 配置

```yaml
- insert:
    - id: comfy-video-studio
      name: dsh-comfy-video-studio
      config:
        baseUrl: http://127.0.0.1:8188
        maxUploadMb: 100
        maxWorkflowMb: 5
        requestTimeoutMs: 30000
        historyLimit: 200
```

默认持久化目录位于 `$DSH_HOME/storages/dsh-comfy-video-studio/`：

- `connections.json`：动态服务器和并发设置；
- `history.json`：任务、队列和历史输出；
- `workflows/<id>/workflow.json`：原始 API JSON；
- `workflows/<id>/definition.json`：页面字段与主输出定义。

服务器地址只接受无内嵌账号密码的 HTTP(S) URL。需要认证时应由反向代理处理。

## 开发

```bash
npm install
npm test
npm run build
npm run check
npm run test:integration
```

`npm run test:integration` 使用模拟 ComfyUI 验证导入、兼容性、上传、双视频输出、并发 1/2、队列和重启恢复，不需要真实 GPU。

## License

MIT
