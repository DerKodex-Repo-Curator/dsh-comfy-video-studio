# dsh-comfy-video-studio

A dynamic ComfyUI video-workflow studio for DeepSeek Harness. Instead of shipping model-specific templates, it imports a **ComfyUI API JSON** file and turns it into a persistent, editable workflow page.

## Features

- Parse scalar inputs, image/video uploads, enums, model selectors, and every `SaveVideo` output.
- Validate missing nodes, models, enum values, output indices, and typed connections against the selected server's `/object_info`.
- Persist, rename, edit, and delete workflow pages.
- Manage multiple ComfyUI servers with health, latency, device, VRAM, and remote-queue status.
- Use an independent FIFO scheduler per server with 1–3 active submission slots.
- Persist queued tasks and reconnect monitoring for tasks that already have a `prompt_id`.
- Save every video output while selecting one node as the primary preview.

Standard single-GPU ComfyUI installations may still execute prompts serially. A slot count above one controls how many prompts the plugin submits; it does not guarantee parallel GPU inference.

## Accepted workflow format

Only API-format JSON is accepted: top-level keys are node IDs and every node contains `class_type` and `inputs`. Canvas JSON is rejected with an explicit re-export message.

Missing dependencies block execution but do not block saving. The plugin never installs nodes/models and does not query an online package registry.

## Configuration

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

Runtime data is stored below `$DSH_HOME/storages/dsh-comfy-video-studio/` in `connections.json`, `history.json`, and one directory per imported workflow.

## Development

```bash
npm install
npm test
npm run build
npm run check
npm run test:integration
```

## License

MIT
