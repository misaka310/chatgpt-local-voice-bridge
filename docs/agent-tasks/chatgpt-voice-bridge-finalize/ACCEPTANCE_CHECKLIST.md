# 受け入れチェックリスト

## 最優先チェック

- [ ] ZIP展開直後またはclone直後にREADMEの手順だけで起動できる
- [ ] `windows_sapi` または `mock_wav` でEnd-to-End確認できる
- [ ] ChatGPTの返答全文ではなく、冒頭3行相当だけを読む
- [ ] 1つのassistant返答につき自動読み上げは1回だけ
- [ ] 参照音源はGitに入らない
- [ ] 生成音声はGitに入らない
- [ ] `config.local.json` はGitに入らない
- [ ] mainにpushしても秘密情報・個人音声・生成物が混ざらない

## Chrome拡張

- [ ] ChatGPTページでパネルが表示される
- [ ] Health確認ができる
- [ ] 「最新を読む」で冒頭previewだけを読む
- [ ] 自動ONで新規返答の冒頭previewだけを読む
- [ ] Stopで再生停止できる
- [ ] Native host未導入時に手動起動案内が出る
- [ ] Native host導入済みならStart/Stopが動く

## ローカルAPI

- [ ] `/health` が200を返す
- [ ] `/v1/speak` が音声URLを返す
- [ ] `/audio/...` で音声を取得できる
- [ ] CORSがChrome拡張/ChatGPTページからの利用に必要な範囲で通る
- [ ] `windows_sapi` / `mock_wav` / `comfyui_qwen3` の設定が分離されている

## Qwen3/ComfyUI

- [ ] `reference/voice.wav` と `reference/voice.txt` の説明がある
- [ ] workflow配置場所が明記されている
- [ ] ComfyUI未起動時に分かるエラーが出る
- [ ] Qwen3 workflowの本文注入先が明記されている
- [ ] 生成ファイルの特定方法が安定している

## ドキュメント

- [ ] README
- [ ] docs/setup.md
- [ ] docs/startup.md
- [ ] docs/reference-audio.md
- [ ] docs/qwen3-comfyui.md
- [ ] docs/chrome-extension.md
- [ ] docs/troubleshooting.md
- [ ] docs/security.md
- [ ] docs/repository-name.md
- [ ] local-api/reference/README.md
