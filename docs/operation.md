# 運用メモ

## 日常運用

1. ComfyUI起動
2. `scripts/start-local-api.ps1`
3. ChatGPTを開く
4. 右下パネルで `Health` 確認
5. 初期状態は `Auto OFF`。必要時のみ `Auto ON`、または `最新を読む`

## 生成物

- 出力先: `local-api/runtime/audio/`
- Git管理外

## 運用上の要点

- Qwen生成パラメータ調整は workflow JSON 側で行う
- 参照音源更新時は `voice.wav` と `voice.txt` を差し替える
- 送信対象は冒頭previewのみ（最大3行/120文字）で、ChatGPT全文は送信しない
