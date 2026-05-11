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

## ComfyUIで失敗する

- ComfyUI起動確認
- `workflowPath` と `outputDir` を再確認
- `reference/voice.wav` と `reference/voice.txt` の配置確認

## 返答全文を読んでしまう

本実装は冒頭previewのみ送信します。古い拡張が読み込まれている場合は、拡張を再読み込みしてください。
