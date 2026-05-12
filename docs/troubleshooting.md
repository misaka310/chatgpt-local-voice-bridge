# トラブルシュート

## .ps1 が実行ポリシーでブロックされる

- 通常は `run-qwen-stack.cmd` から起動する
- `.cmd` はその実行1回だけ `ExecutionPolicy Bypass` を付与する
- 管理者権限への昇格ではない
- scripts配下からは `scripts\start-qwen-stack.cmd` でも同じ動作

## run-qwen-stack.cmd で起動してもすぐ終了する

- `D:\05_ComfyUI_ZImage\run.bat` が存在するか確認
- `http://127.0.0.1:8190/system_stats` が応答するか確認
- `local-api/server.py` が存在するか確認
- `http://127.0.0.1:8765/health` が応答するか確認
- ログは `local-api/runtime/logs/` を確認

## Ctrl+C / ターミナルクローズ時の停止について

- 起動スクリプトが開始した ComfyUI / local-api のみ停止対象
- 既存で起動済みだった ComfyUI / local-api は停止しない
- 追跡情報は `local-api/runtime/qwen-stack.json` に保存され、終了時に削除される

## /health が失敗する

- `local-api/reference/voice.wav` が存在するか
- `local-api/reference/voice.txt` が存在するか
- `local-api/workflows/qwen3_clone_api.json` が存在するか
- 個人workflowを使う場合、`config.local.json` の `comfyui.workflowPath` が実在ファイルを指しているか
- `comfyui.inputDir` / `comfyui.outputDir` が存在するか
- ComfyUI が起動しているか
- `comfyui.baseUrl` が `http://127.0.0.1:8190` か

## /v1/speak が失敗する

- `/prompt` への接続失敗: ComfyUI URL確認
- `/history` で status=error: Qwen3 node/モデル/LoadAudio設定を確認
- `LoadAudio.inputs.audio` の読み込み失敗: inputDir内 `voice.wav` 配置を確認

## Chromeで再生されない

- APIログで `POST /v1/speak` と `GET /audio/...` が200か確認
- ChatGPTタブを1回クリックして自動再生制限を解除
- 拡張を再読み込み

## Read Latest / Replay のキャッシュ確認

- 初回 `Read Latest`: `POST /v1/speak` が1回増える
- 同じpreviewで2回目 `Read Latest`: `POST /v1/speak` は増えず `GET /audio/...` のみ
- `Replay`: `POST /v1/speak` は増えず `GET /audio/...` のみ
- local-apiを再起動して再生失敗した場合は、次の `Read Latest` で再生成される

## Native hostを使う場合のみ失敗する

```powershell
.\scripts\install-native-host.ps1 -ExtensionId <拡張ID>
```
