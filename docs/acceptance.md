# 受け入れ条件

## 必須前提

- ComfyUIが起動している
- Qwen3-TTS custom node が導入済み
- 必要モデルが利用可能
- `local-api/reference/voice.wav` が存在する
- `local-api/reference/voice.txt` が存在する
- `local-api/workflows/qwen3_clone_api.json`（標準workflow）が存在する
- 設定の `engine` が `comfyui_qwen3`

## API E2E

- `scripts/start-local-api.ps1` で起動
- `/health` が `engine=comfyui_qwen3`
- `scripts/smoke-local-api.ps1` で `/v1/speak` 成功
- ComfyUI `/prompt` 実行と `/history/{prompt_id}` 成功
- 生成音声が `local-api/runtime/audio/` へコピーされる
- `/audio/<filename>` が再生できる

## Chrome E2E

- 拡張読み込み後、ChatGPTタブリロード
- 初期状態は `Auto OFF` である
- 「最新を読む」または自動検知で送信されるのは冒頭previewのみ
- 送信されるpreviewは最大3行/120文字
- 1応答につき自動送信1回のみ
- 全文は送信されない
- Qwen3音声が再生される

## 完了判定

- Qwen3 E2Eが通って初めて完了
- 未実施時は `/prompt`・`/history`・LoadAudio・モデル読み込み・音声取得のどこまで通ったかを具体的に報告する
