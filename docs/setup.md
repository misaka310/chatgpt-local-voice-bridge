# セットアップ

## 前提

- Windows 11
- Python 3.10+
- Google Chrome
- ComfyUI 起動可能環境
- Qwen3-TTS Voice Clone custom node とモデル利用可能状態

## 必須ファイル

- `local-api/reference/voice.wav`
- `local-api/reference/voice.txt`
- `local-api/workflows/qwen3_clone_api.json`（標準workflow、Git追跡）

## 設定

- 標準例（Git追跡）: `local-api/config.example.json`
- 実運用のローカル上書き（Git管理外）: `local-api/config.local.json`
- Qwen3設定例（Git追跡）: `local-api/config.qwen3.example.json`
- `local-api/config.json` はローカル互換用（任意、Git管理外）

## workflowの使い分け

- 標準は `local-api/workflows/qwen3_clone_api.json` を使う
- 個人調整版workflowを使う場合は `local-api/workflows/qwen3_clone_api.local.json` を作成し、
  `config.local.json` の `comfyui.workflowPath` で切り替える

## 起動

```powershell
.\scripts\start-local-api.ps1
```

## 疎通確認

```powershell
.\scripts\smoke-local-api.ps1
```

`/health` が `engine=comfyui_qwen3` を返すことを確認してください。
