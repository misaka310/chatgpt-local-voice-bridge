# Qwen3 / ComfyUI

## 運用方針

- **最終運用エンジンは `comfyui_qwen3`**
- `windows_sapi` / `mock_wav` は疎通確認専用
- `mock_wav` 成功だけでは完了扱いにしません

## 事前準備

- ComfyUIを起動
- Qwen3 Voice Clone workflowをAPI形式で保存
- `local-api/workflows/qwen3_clone_api.json` に配置
- `local-api/reference/voice.wav` と `local-api/reference/voice.txt` を配置

## 設定

`local-api/config.local.json` の例は以下を使ってください。

- `local-api/config.qwen3.example.json`

例:

```json
{
  "engine": "comfyui_qwen3",
  "referenceAudioPath": "./reference/voice.wav",
  "referenceTextPath": "./reference/voice.txt",
  "comfyui": {
    "baseUrl": "http://127.0.0.1:8188",
    "workflowPath": "./workflows/qwen3_clone_api.json",
    "outputDir": "C:/ComfyUI/output",
    "timeoutSec": 300,
    "pollIntervalSec": 1.0,
    "defaultAudioExt": ".wav"
  }
}
```

## Python側の注入範囲

`server.py` が実行時に差し替えるのは以下のみです。

- `Qwen3VoiceClone.inputs.text`
- SaveAudio系ノードの保存名
- 対応キーがある場合の参照音源パス
- 対応キーがある場合の参照文字起こしパス

## Qwenパラメータの管理場所

- seed
- temperature
- speed
- max tokens
- sampling系
- 声質ノード設定

これらは **ComfyUI workflow JSON側で管理** し、Pythonにハードコードしません。

## 最終確認

1. `scripts/start-local-api.ps1`
2. `/health` が `engine=comfyui_qwen3`
3. `scripts/smoke-local-api.ps1` がQwen3経由で音声生成
4. ChatGPTで `最新を読む` を押し、冒頭previewのみ再生される
