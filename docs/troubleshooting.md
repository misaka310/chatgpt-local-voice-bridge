# トラブルシュート

## パネルが「未起動」のまま

1. `./scripts/start-local-api.ps1` を実行
2. `http://127.0.0.1:8765/health` を開く
3. パネルの `Health` を押す

## Start APIが失敗する

- Native host未導入の可能性があります
- 拡張IDを確認して再登録してください

```powershell
.\scripts\install-native-host.ps1 -ExtensionId <拡張ID>
```

## 音声が再生されない

- `./scripts/smoke-local-api.ps1` で単体疎通確認
- APIログに `POST /v1/speak` と `GET /audio/...` が出るか確認
- ChatGPTタブ上で1回クリックして自動再生制限を解除

## Qwen3で生成できない

- ComfyUIが起動しているか
- `local-api/config.local.json` の `engine` が `comfyui_qwen3` か
- `local-api/workflows/qwen3_clone_api.json` が存在するか
- `local-api/reference/voice.wav` と `local-api/reference/voice.txt` が存在するか
- `/health` が `engine=comfyui_qwen3` を返すか

## mock_wav では動くが本番で失敗する

`mock_wav` / `windows_sapi` は疎通確認専用です。  
最終完了にはQwen3/ComfyUI経由の生成・再生確認が必要です。

## 返答全文を読んでしまう

本実装は冒頭preview（最大3行/120文字）のみ送信します。古い拡張が読み込まれている場合は、拡張を再読み込みしてください。
