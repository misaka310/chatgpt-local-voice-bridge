# Acceptance

## 事前条件

- ComfyUI 起動済み
- `local-api/reference/voice_irodori.wav` が存在
- v2 workflow が存在
  - `local-api/reference/tts_e2e_irodori.json`
- v3 workflow が存在
  - `D:/ComfyUI_TTS_E2E_SANDBOX/ComfyUI/user/default/workflows/tts_e2e_irodori_v3.json`

## API 受け入れ

1. `/health` が成功
2. `engine=comfyui_workflow`
3. `availableVoiceProfiles` に `irodori-v2`, `irodori-v3`
4. `/v1/speak` `voiceProfile=irodori-v2` で成功
5. `/v1/speak` `voiceProfile=irodori-v3` で成功

## UI 受け入れ

1. Voice select で `Irodori v2 / Irodori v3` を切替できる
2. 選択は `chrome.storage.local` に保持され、タブリロード後も維持される
3. `Read` は chunk 0
4. `Next` は次チャンク
5. `Regen` は現在チャンク強制再生成
6. `Replay` は再生成なし
7. `Auto` は chunk 0 のみ

## キャッシュ受け入れ

- キャッシュキーに `voiceProfile`, `messageKey`, `chunkIndex`, 正規化本文が含まれる
- v2 で生成した音声を v3 で再利用しない

## チャンク受け入れ

- 1チャンクは短いまま（既定: 2行 / 80文字 / 最小25文字）
- コードブロック除外
- markdown記号を落とす
- 句読点優先分割、不可なら maxChars 分割
- 全文一括送信しない
