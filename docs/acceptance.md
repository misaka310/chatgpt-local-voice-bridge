# 受け入れ条件

## 疎通確認

- `mock_wav` または `windows_sapi` で `/health` が成功
- `/v1/speak` が成功
- 生成音声URLが再生できる

## Qwen3最終確認

- ComfyUIが起動している
- `local-api/config.local.json` の `engine` が `comfyui_qwen3`
- `local-api/reference/voice.wav` が存在する
- `local-api/reference/voice.txt` が存在する
- `local-api/workflows/qwen3_clone_api.json` が存在する
- `scripts/start-local-api.ps1` でローカルAPIが起動する
- `/health` が `engine=comfyui_qwen3` を返す
- `scripts/smoke-local-api.ps1` がQwen3経由で音声を生成できる
- Chrome拡張の「最新を読む」でChatGPT冒頭previewだけがQwen3音声で再生される
- assistant 1応答につき自動送信は1回だけ
- 全文は送信されない

## 完了条件

- `mock_wav` 成功だけでは完了にしない
- Qwen3最終確認を満たして初めて完了
- 環境不足でQwen3 E2E未実施なら、未実施理由と必要ファイル/起動条件をREADMEへ明記する
