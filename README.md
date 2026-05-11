# chatgpt-local-voice-bridge

Web版ChatGPTのassistant返答を検知し、**冒頭preview（最大3行/120文字）だけ**をローカルTTS APIへ送って再生する、Chrome拡張 + ローカルAPIです。

- **最終運用エンジンは `comfyui_qwen3`**
- `windows_sapi` / `mock_wav` は疎通確認専用
- 参照音源 (`voice.wav` / `voice.txt`) は Git に入れない
- 拡張からStart/Stopするには Native Messaging host が必要

## 重要: 完了判定

`mock_wav` や `windows_sapi` での成功は、あくまで経路の疎通確認です。  
**最終受け入れ条件は、ChatGPT冒頭previewが `comfyui_qwen3` 経由で生成・再生されること** です。

## 最短セットアップ（疎通確認）

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

## Qwen3最終運用への切替

1. `local-api/reference/voice.wav` を配置
2. `local-api/reference/voice.txt` を配置
3. ComfyUI workflowをAPI形式で保存し `local-api/workflows/qwen3_clone_api.json` に配置
4. `local-api/config.local.json` で `engine=comfyui_qwen3` を設定
   - 例: `local-api/config.qwen3.example.json`
5. API再起動後、`/health` が `engine=comfyui_qwen3` を返すことを確認

## 主要ドキュメント

- [セットアップ](docs/setup.md)
- [起動方法](docs/startup.md)
- [受け入れ条件](docs/acceptance.md)
- [参照音源](docs/reference-audio.md)
- [Qwen3/ComfyUI](docs/qwen3-comfyui.md)
- [Chrome拡張](docs/chrome-extension.md)
- [トラブルシュート](docs/troubleshooting.md)
- [セキュリティ](docs/security.md)
- [リポジトリ名](docs/repository-name.md)

## 注意

- ChatGPT返答全文を自動送信しない
- Playwright常駐監視は本実装の対象外
- Native Messagingなしで拡張からPowerShellを直接実行しない
