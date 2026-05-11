# 参照音源

配置先:

```text
local-api/reference/voice.wav
local-api/reference/voice.txt
```

- `voice.wav`: 参照音源
- `voice.txt`: 参照文字起こし

どちらも Git 管理しません。

`server.py` は生成前に `voice.wav` を `comfyui.inputDir` へコピーし、
`voice.txt` の内容を `Qwen3VoiceClone.inputs.ref_text` に注入します。
