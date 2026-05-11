# Qwen3 / ComfyUI

## 概要

初期E2Eは `windows_sapi` または `mock_wav` を使用し、実運用時に `comfyui_qwen3` へ切り替えます。

## 事前準備

- ComfyUIを起動
- Qwen3 Voice Clone workflowをAPI形式で保存
- `local-api/workflows/qwen3_clone_api.json` に配置

## 設定

`local-api/config.local.json` 例:

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
    "pollIntervalSec": 1.0
  }
}
```

## 注入仕様

- `Qwen3VoiceClone.inputs.text` に本文を注入
- `SaveAudio` 系ノードの保存名を一意化
- 対応キーがあれば参照音源/文字起こしパスを注入

## エラー時

- ComfyUI未起動: `/prompt` 接続失敗
- workflow不一致: `Qwen3VoiceClone.inputs.text was not found`
- 出力特定失敗: outputDirの最新音声探索でも見つからない
