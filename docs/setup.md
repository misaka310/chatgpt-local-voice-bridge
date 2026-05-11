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
- `local-api/workflows/qwen3_clone_api.json`

## 設定

- 基本設定: `local-api/config.example.json`
- ローカル上書き（Git管理外）: `local-api/config.local.json`
- Qwen3設定例: `local-api/config.qwen3.example.json`

## 起動

```powershell
.\scripts\start-local-api.ps1
```

## 疎通確認

```powershell
.\scripts\smoke-local-api.ps1
```

`/health` が `engine=comfyui_qwen3` を返すことを確認してください。
