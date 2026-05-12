# トラブルシュート

## .ps1 実行ポリシーでブロックされる

- `run-voice-stack.cmd` を使う
- 互換で `run-qwen-stack.cmd` も使える

## run-voice-stack.cmd がすぐ終了する

- `D:/ComfyUI_TTS_E2E_SANDBOX/start_comfyui_tts_sandbox.bat` が存在するか
- `http://127.0.0.1:8288/system_stats` が応答するか
- `local-api/server.py` が存在するか
- `http://127.0.0.1:8765/health` が応答するか
- `local-api/runtime/logs/` を確認

## /health が失敗する

- `local-api/reference/voice_irodori.wav` が存在するか
- `local-api/reference/tts_e2e_irodori.json` が存在するか
- `config.local.json` の `workflowPath` と `referenceAudioPath` が正しいか
- `comfyui.inputDir` / `comfyui.outputDir` が存在するか
- `comfyui.baseUrl` が正しいか

## /v1/speak が失敗する

- `/prompt` 接続失敗: ComfyUI URL確認
- `/history` status=error: workflowノード設定を確認
- 参照音源ノードがあるworkflowの場合: inputDirへのコピー先ファイル名注入が失敗していないか確認
- debugファイル: `local-api/runtime/debug/<requestId>/summary.json`

## キャッシュ挙動を確認したい

- 1回目 `Read`: `POST /v1/speak` が増える
- 同じpreviewで2回目 `Read`: `POST /v1/speak` は増えない
- `Regen`: `POST /v1/speak` が増える
- `Replay`: `POST /v1/speak` は増えない

## 折りたたみ状態/位置が保持されない

- 拡張を再読み込み
- `chrome.storage.local` の `panelCollapsed` / `panelPosition` が更新されるか確認
