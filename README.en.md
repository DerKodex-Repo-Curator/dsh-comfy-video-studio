# dsh-comfy-video-studio

[中文](./README.md) | English

A full-screen ComfyUI MiniMax H3 video studio for DeepSeek Harness. Version 0.6 lets users create, test, edit, select, and delete persistent ComfyUI connection presets directly in the running UI without editing the plugin profile or restarting Harness. It keeps task-level connection snapshots, optional explicit self-signed TLS support, and direct submission of bundled API workflow JSON to the selected instance. It also provides text-to-video, image-to-video, and one-to-three arbitrary-time keyframe workflows; persistent generation history; prompt optimization; image upload; live progress; Range-enabled playback; and absolute-directory delivery on the Harness host.

This is an unofficial community plugin. It supports DeepSeek Harness Web `0.1.1-rc.2`, Node.js 20 or newer, and has been validated with ComfyUI `0.33.1`.

## Install

Install the prebuilt npm package:

```powershell
dsh plugin --profile web add dsh-comfy-video-studio
```

The Chinese README also documents installation from a GitHub Release or a source checkout.

See [README.md](./README.md) for the Chinese documentation with installation, configuration, and operational details.
