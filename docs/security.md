# セキュリティ

## 基本方針

- ローカルAPIは `127.0.0.1` で待ち受ける
- 外部公開しない
- 参照音源/生成音声/秘密情報をGitに入れない

## Git除外対象

- `local-api/config.local.json`
- `local-api/runtime/`
- `local-api/reference/*.wav`, `*.txt`
- モデルファイル（`*.safetensors` など）

## Chrome拡張権限

- `storage`
- `nativeMessaging`
- `http://127.0.0.1:8765/*`
- `http://localhost:8765/*`
- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

## 公開前チェック

1. `config.local.json` をコミットしていない
2. 参照音源と生成音声がコミット対象に入っていない
3. host permissions が過剰でない
