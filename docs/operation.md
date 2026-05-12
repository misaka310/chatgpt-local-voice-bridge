# 運用メモ

## 日常運用

1. `run-voice-stack.cmd`
2. ChatGPTを開く
3. 必要時のみ `Auto` をON
4. 手動は `Read` / `Regen` / `Replay` を使い分ける

## 生成物

- 出力先: `local-api/runtime/audio/`
- debug: `local-api/runtime/debug/<requestId>/`
- Git管理外

## 要点

- 生成パラメータは `tts_e2e_irodori.json` 側で管理
- 送信対象は冒頭previewのみ（最大2行/80文字）
- 参照音源は `voice_irodori.wav`
