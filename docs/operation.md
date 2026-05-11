# 運用メモ

## 日常運用

1. ComfyUI起動
2. `scripts/start-local-api.ps1`
3. ChatGPTを開く
4. 右下パネルで `Health` 確認
5. 自動読み上げ or `最新を読む`

## 生成物

- 出力先: `local-api/runtime/audio/`
- Git管理外

## 運用上の要点

- Qwen生成パラメータ調整は workflow JSON 側で行う
- 参照音源更新時は `voice.wav` と `voice.txt` を差し替える
