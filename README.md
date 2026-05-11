# chatgpt-local-voice-bridge

Web版ChatGPTのassistant返答を検知し、**冒頭preview（最大3行/120文字）だけ**をローカルTTS APIへ送って再生する、Chrome拡張 + ローカルAPIです。

- 初期E2Eは `windows_sapi` または `mock_wav` で確認可能
- `engine=comfyui_qwen3` へ設定切り替え可能
- 参照音源 (`voice.wav` / `voice.txt`) は Git に入れません
- 拡張からStart/Stopするには Native Messaging host が必要

## 最短セットアップ

1. ローカルAPI起動
```powershell
.\scripts\start-local-api.ps1
```

2. 疎通確認
```powershell
.\scripts\smoke-local-api.ps1
```

3. Chrome拡張を読み込み
- `chrome://extensions` を開く
- デベロッパーモードON
- `extension/` を読み込む

4. ChatGPTで確認
- `https://chatgpt.com/` を開く
- 返答生成時に右下 `Local Voice` パネルが表示
- 自動ONで新規assistant返答ごとに1回だけ冒頭previewを送信

## 拡張UI

- 状態表示: `未起動 / 起動中 / 生成中 / 再生中 / エラー`
- `Health`: APIの `/health` 確認
- `Start API` / `Stop API`: Native host経由で起動・停止（未導入時は手動案内表示）
- `最新を読む`: 冒頭previewだけを手動送信

## 主要ドキュメント

- [セットアップ](docs/setup.md)
- [起動方法](docs/startup.md)
- [参照音源](docs/reference-audio.md)
- [Qwen3/ComfyUI](docs/qwen3-comfyui.md)
- [Chrome拡張](docs/chrome-extension.md)
- [トラブルシュート](docs/troubleshooting.md)
- [セキュリティ](docs/security.md)
- [リポジトリ名](docs/repository-name.md)

## 注意

- ChatGPT返答全文を自動送信しません
- Playwright常駐監視は本実装の対象外です
- Native Messagingなしで拡張からPowerShellを直接実行する機能は実装していません
