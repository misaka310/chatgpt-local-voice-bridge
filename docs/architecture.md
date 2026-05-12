# アーキテクチャ

```text
ChatGPT Web
  ↓ (content script)
Chrome extension
  - 冒頭preview抽出 (max 2 lines / 80 chars)
  - 1応答1回の自動送信
  - 音声再生キュー / キャッシュ
  ↓
local-api /v1/speak (comfyui_workflow)
  - workflow読込
  - text / save名 / referenceAudio(必要時) 注入
  - ComfyUI /prompt -> /history
  - runtime/audioへコピー
```

## ポイント

- Playwright常駐監視は採用しない
- 返答全文の自動送信はしない
- 拡張からAPI起動する場合はNative Messaging host経由
