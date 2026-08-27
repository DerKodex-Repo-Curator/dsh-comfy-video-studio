# dsh-comfy-video-studio

[English](./README.en.md) | 中文

DeepSeek Harness 的全屏 ComfyUI 视频工作台。插件内置文生视频、图生视频和 1–3 图任意时刻关键帧工作流，支持工作流预设、持久化制作记录、用户自定义提示词模板、当前会话模型提示词优化、参数调整、任务进度、视频播放以及任意绝对目录落盘。

## 工作方式

- 浏览器只访问 Harness 的同源 `/comfy-video/api`，不会直接暴露 ComfyUI，也不能把任意 URL 交给 Host 代理。
- Host 按页面选择的连接预设访问对应 ComfyUI REST 与 WebSocket；WebSocket 失效时用该实例的 History 轮询兜底。
- “AI 优化”读取当前 Harness 会话选择的 provider/model，先判断是否存在会影响成片的歧义。信息充分时直接覆盖提示词；信息不足时自动返回当前对话提问，确认后自动回到工作台覆盖提示词。
- 优化过程显示当前阶段、所用模型、澄清问题和优化前后字数；优化完成前“生成视频”保持禁用。
- 提示词右上角的“展开查看”会打开大尺寸可编辑窗口，便于检查长提示词。
- 不再附带预置提示词模板。用户可按文生视频、图生视频或关键帧模式保存、套用、更新和删除自己的模板；模板与历史记录一起持久化。
- 制作记录原子写入 `$DSH_HOME/storages/dsh-comfy-video-studio/history.json`，重启 Harness 后仍可查看；已有 `prompt_id` 的未结束任务会尝试恢复 ComfyUI 监控。
- ComfyUI 完成后，Host 通过 `/view` 流式读取视频并原子写入页面指定的绝对目录。
- 播放端点支持 HTTP Range，可以拖动大视频的播放进度。
- 工作台跟随 DeepSeek Harness 的浅色/深色主题，不维护独立主题状态。
- MiniMax H3 固定按 24 FPS 建立时间轴，所有模式在生成后严格裁到目标时长。

## 构建

```powershell
npm install
npm run build
npm run check
```

## 安装到远程 Harness

将整个插件目录或 `npm pack` 生成的 `.tgz` 复制到远程机，然后执行：

```powershell
dsh plugin --profile web add <插件目录或tgz路径>
```

重新启动 `dsh web`。侧栏底部会出现“视频工作台”。

未配置连接预设时，继续兼容旧版 `baseUrl`，默认连接 `http://127.0.0.1:8188`。如需在页面动态切换多个 ComfyUI，编辑该 profile 的插件配置：

```yaml
- id: comfy-video-studio
  name: dsh-comfy-video-studio
  config:
    defaultConnectionPresetId: remote-local
    connectionPresets:
      - id: remote-local
        name: 远程机 ComfyUI（内网）
        baseUrl: http://127.0.0.1:8188
      - id: remote-frp
        name: 远程机 ComfyUI（FRP）
        baseUrl: https://comfy.example.com:443
        # 仅当服务确实使用自签名证书时开启；优先换成可信证书
        allowSelfSigned: true
    maxUploadMb: 40
    requestTimeoutMs: 30000
    historyLimit: 200
    # historyFile: D:\DSHData\comfy-video-history.json
    # workflowDirectory: D:\DSHData\comfy-video-workflows
```

连接预设由 Host 配置管理，页面只传稳定的预设 ID。切换连接后，新任务会使用新实例；正在执行和历史恢复中的任务继续绑定创建时的实例快照。图片上传属于具体 ComfyUI 实例，因此切换连接会清空当前图片引用并要求重新上传。

## 工作流预设

- 内置预设 ID 为 `minimax-h3-default`，覆盖文生、图生和 1/2/3 关键帧五个 API 工作流。
- 五份 API JSON 随插件保存在 `assets/workflows`。生成时 Host 直接将对应 JSON 注入参数后提交给所选 ComfyUI 的 `/prompt`，无需先导入画布工作流。
- 页面既可以下拉选择预设，也可以手动输入同一个稳定预设 ID；ComfyUI 返回的 `prompt_id` 只是单次任务 ID，不是工作流绑定 ID。
- 自定义目录中的 `*.preset.json` 会在页面刷新预设时重新扫描，无需重启 Harness。预设必须声明 API JSON、画布 JSON 和语义节点绑定；缺文件、重复 ID 或失效绑定会被拒绝。
- `assets/workflows` 同时提供五份 API JSON 和五份可拖入 ComfyUI 的 `.workflow.json`；画布版仅用于人工查看和调试。画布版关键帧图片是占位符，导入后必须重新选择。

## ComfyUI 启动要求

- Harness 和 ComfyUI 位于同一台机器时，ComfyUI 保持监听 `127.0.0.1` 即可，无需向局域网暴露。
- 工作流所需自定义节点和 MiniMax H3 模型必须已经安装。
- 页面连接检测会调用 `/object_info` 并报告缺失节点。

## 绝对输出目录

页面填写的是 **Harness Host 所在机器**的绝对路径，例如：

```text
D:\Videos\MiniMax
/data/videos/minimax
```

插件会创建不存在的目录。ComfyUI 仍先把视频生成到自己的 output；完成后插件把结果流式复制到目标目录。已有同名文件不会覆盖，会自动追加任务 ID。

## AI 提示词默认规则

用户没有明确提出相反要求时，AI 会把以下规则整合进三个模式的提示词：平滑连续运镜且停顿不超过 500ms、9:16 手机竖屏、轻微自然手持抖动、人物头部和身体不追随镜头、视线不追随镜头、平均每 3–8 秒自然眨眼一次。短于 3 秒的视频不强制眨眼。模型必须逐项报告规则是已应用还是被用户明确覆盖，缺项会自动重试一次。

## 当前限制

- 对话澄清依赖模型在最终回答中保留工作台提供的回填标签；如果模型未按约定输出，可取消本次优化后重试。
- ComfyUI `/interrupt` 是实例级操作；本插件按单人自用设计，不建议与其他队列客户端同时运行。
- 提示词约束不能从数学上保证人物姿态、视线或眨眼结果；需要用实际生成结果评估。
- 画布 JSON 的结构已在本地验证；节点和模型枚举仍以目标 ComfyUI 的 `/object_info` 为准。

## 关键帧模式

关键帧模式允许添加 1–3 张图片，每张图片都有稳定引用 `@K1`、`@K2`、`@K3` 和独立秒数。图片可位于 `0 ≤ 时间 < 目标时长` 的任意位置；没有第 0 秒图片时，由文本条件生成开场。Host 按时间排序后把秒数换算成 24 FPS 帧号，并自动选择对应数量的工作流变体。两个时间取整到同一帧时会拒绝提交。

默认分辨率是精确 9:16 的 `576×1024`，另提供兼容旧设置的 `768×1344` 高清档（近似 9:16）。

## 卸载

```powershell
dsh plugin --profile web remove dsh-comfy-video-studio
```

## 开源许可

本项目使用 [MIT License](LICENSE)。
