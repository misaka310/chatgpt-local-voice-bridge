# セットアップ

## 前提

- Windows 11
- Python 3.10+
- Google Chrome
- ComfyUI 起動可能環境
- Irodori TTS workflow を実行できるComfyUIノード環境

## 必須ファイル

- `local-api/reference/voice_irodori.wav`
- `local-api/reference/tts_e2e_irodori.json`

## 設定

- 例（Git追跡）: `local-api/config.example.json`
- 実運用（Git管理外）: `local-api/config.local.json`
- voice profile例: `local-api/voices/irodori.example.json`

## 起動

```cmd
run-voice-stack.cmd
```

## 疎通確認

```powershell
.\scripts\smoke-local-api.ps1
```

`/health` が `engine=comfyui_workflow` と `voiceProfile=irodori` を返すことを確認してください。
