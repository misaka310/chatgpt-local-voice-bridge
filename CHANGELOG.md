# Changelog

## 2026-05-11

- 冒頭preview読み上げ仕様を実装（最大3行/120文字、1応答1回送信）
- 拡張UIに `Health` / `Start API` / `Stop API` を追加
- Native Messaging host (`tools/native-host`) と install/uninstall スクリプトを追加
- ローカルAPI設定を優先順ロードに整理（env > config.local > config > example > defaults）
- ComfyUI連携で参照音源/文字起こしパス注入に対応
- `.gitignore` と参照音源運用を整理
- ドキュメント一式を更新
