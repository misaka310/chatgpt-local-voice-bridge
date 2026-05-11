# Qwen3 / ComfyUI

このリポジトリは Qwen3/ComfyUI専用です。

## 実workflow

- `local-api/workflows/qwen3_clone_api.json`
- 32_dotitao-room 実績構成（Qwen3Loader / LoadAudio / Qwen3VoiceClone / SaveAudio）を移植

## 注入ルール（Python側）

`local-api/server.py` が実行時に更新するのは次のみです。

- `Qwen3VoiceClone.inputs.text`
- `Qwen3VoiceClone.inputs.ref_text`（`voice.txt` 内容を上書き注入）
- `LoadAudio.inputs.audio`（ComfyUI inputにコピーした `voice.wav`）
- `SaveAudio.inputs.filename_prefix`（一意化）

## Qwenパラメータの管理場所

以下は workflow JSON 側で管理します。

- seed
- generation_mode
- language
- max_new_tokens
- ref_audio_max_seconds
- sampling系
- 速度/温度等の生成パラメータ

Pythonへハードコードしません。

## LoadAudio運用

- `referenceAudioPath` (`local-api/reference/voice.wav`) を
  `comfyui.inputDir` へコピーして使用します。
- workflow の `LoadAudio.inputs.audio` には `voice.wav` を注入します。

## 設定例

`local-api/config.qwen3.example.json` を参照してください。
ComfyUIが 8190 ポート運用の場合は、`config.local.json` で
`comfyui.baseUrl` を `http://127.0.0.1:8190` に上書きします。
