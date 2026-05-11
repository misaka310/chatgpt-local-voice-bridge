# 参照音源

Qwen3/ComfyUI運用時は、以下を配置します。

```text
local-api/reference/
  voice.wav
  voice.txt
```

- `voice.wav`: 参照音声
- `voice.txt`: 参照音声の文字起こし
- 実ファイルはGit管理外（`.gitignore`で除外）

`engine=comfyui_qwen3` のとき、workflowノードに対応キーがあればこのパスを注入します。
既存workflowが固定参照を持つ場合は、ファイル未配置でも動作可能です。

詳細: [local-api/reference/README.md](../local-api/reference/README.md)
