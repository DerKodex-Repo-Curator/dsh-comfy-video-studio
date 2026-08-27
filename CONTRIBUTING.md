# 贡献指南

感谢你改进 Comfy 视频工作台。

## 开发原则

- 浏览器端只访问 Harness 同源 API；不要让浏览器绕过 Host 直接连接 ComfyUI。
- 所有文件写入必须限制在用户明确指定的目标内，并保留现有的原子写入与不覆盖策略。
- 工作流改动必须同时更新 API JSON、可导入画布 JSON、预设清单和结构检查。
- 不提交模型、输入素材、生成视频、制作历史、环境变量、缓存、依赖目录或打包产物。
- 新增第三方代码或素材时，必须同时补充来源与许可证说明。

## 本地验证

```powershell
npm install
npm run build
npm run check
```

只有在 Harness 与 ComfyUI 测试环境已配置时才运行：

```powershell
npm run test:integration
```

Pull Request 应说明问题根因、用户可见变化、验证结果，以及对工作流或持久化数据的兼容性影响。
