# セキュリティ

## 基本方針

- ローカルAPIは `127.0.0.1` 待受
- 外部公開しない
- 参照音源/参照文字起こし/ローカル設定をGitに入れない

## Git除外対象

- `local-api/config.local.json`
- `local-api/runtime/`
- `local-api/logs/`
- `local-api/reference/*.wav` / `*.txt`

## 拡張権限

- `storage`
- `nativeMessaging`
- `http://127.0.0.1:8765/*`
- `http://localhost:8765/*`
- `https://chatgpt.com/*`
- `https://chat.openai.com/*`
