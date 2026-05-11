# アーキテクチャ

```text
ChatGPT Web
  ↓ (content script)
Chrome extension
  - 冒頭preview抽出 (max 3 lines / 120 chars)
  - 1応答1回の自動送信
  - 音声再生キュー
  ↓
local-api /v1/speak
  - windows_sapi / mock_wav / comfyui_qwen3
  - /audio/<file> を返却
```

## ポイント

- Playwright常駐監視は採用しない
- 返答全文の自動送信はしない
- 拡張からAPI起動する場合はNative Messaging host経由
