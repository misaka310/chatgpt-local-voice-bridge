# Troubleshooting

## /health が失敗する

確認ポイント:

- `engine` が `comfyui_workflow`
- ComfyUI が起動している（`http://127.0.0.1:8288/system_stats`）
- `local-api/config.local.json` の profile 設定が正しい
- `voiceProfiles` を使う場合、`irodori-v2` / `irodori-v3` の `workflowPath` と `referenceAudioPath` が有効

## /v1/speak が失敗する

- `voiceProfile` が存在するIDか
  - `irodori-v2`
  - `irodori-v3`
- `workflowVersion` を使う場合は `v2` / `v3`
- ComfyUI `/history` が `status=error` の場合は workflow ノード設定を確認

## profile切替で意図しない音が再生される

キャッシュキーは profile 分離です。

- key: `voiceProfile::messageKey::chunkIndex::normalizedText`

同一メッセージ・同一本文でも profile が違えば別キャッシュになります。

## ボタン動作の期待

- `Read`: chunk 0（同一条件で2回目はキャッシュ再生）
- `Next`: 次チャンク
- `Regen`: 現在チャンクを強制再生成（`/v1/speak` 増える）
- `Replay`: 再生成しない（`/v1/speak` 増えない）
- `Auto`: chunk 0 のみ

## デバッグ確認

- `local-api/runtime/debug/<requestId>/summary.json`
  - `voiceProfile`
  - `workflowPath`
  - `textHash`
  - `ttsInputHash`
  - `referenceAudioHash`
  - `audioPath`

## ログとターミナル

- 詳細な実行ログは `local-api/runtime/logs/` に出力されます。
  - `comfyui-*.log`
  - `local-api-*.log`
- `run-voice-stack.cmd` 実行時にターミナルが複数開いてしまう場合：
  - 外部の ComfyUI 起動用 bat（`D:\ComfyUI_TTS_E2E_SANDBOX\start_comfyui_tts_sandbox.bat` など）の中で `start` や `cmd /k` が使われていないか確認してください。
  - `VOICE_STACK_CONTROLLED=1` 環境変数がセットされた際の挙動を確認してください。
