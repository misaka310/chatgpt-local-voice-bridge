# トラブルシュート

## /health が失敗する

- `local-api/reference/voice.wav` が存在するか
- `local-api/reference/voice.txt` が存在するか
- `local-api/workflows/qwen3_clone_api.json` が存在するか
- `comfyui.inputDir` / `comfyui.outputDir` が存在するか
- ComfyUI が起動しているか

## /v1/speak が失敗する

- `/prompt` への接続失敗: ComfyUI URL確認
- `/history` で status=error: Qwen3 node/モデル/LoadAudio設定を確認
- `LoadAudio.inputs.audio` の読み込み失敗: inputDir内 `voice.wav` 配置を確認

## Chromeで再生されない

- APIログで `POST /v1/speak` と `GET /audio/...` が200か確認
- ChatGPTタブを1回クリックして自動再生制限を解除
- 拡張を再読み込み

## Native host Start API が失敗する

- 拡張IDで再登録:

```powershell
.\scripts\install-native-host.ps1 -ExtensionId <拡張ID>
```
