# 参照音源

配置先:

```text
local-api/reference/voice_irodori.wav
```

- `voice_irodori.wav` はGit管理しません
- `server.py` は実行時にSHA1を計算します
- 参照音源ノードを使うworkflowの場合のみ `comfyui.inputDir` へコピーして注入します
- 参照音源ノードを使わないworkflowでは注入しません（`referenceAudioUsed=false`）

workflow JSON は次を想定します。

```text
local-api/reference/tts_e2e_irodori.json
```

このworkflowファイルも個人環境依存がある場合はGit管理しません。
