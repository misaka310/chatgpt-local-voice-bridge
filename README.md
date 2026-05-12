# chatgpt-local-voice-bridge

ChatGPT Web の assistant 返答を短いチャンクに分割し、ComfyUI workflow 経由でローカル再生するブリッジです。

## 主要機能

- エンジン: `comfyui_workflow` のみ
- Voice Profile を拡張UIで切替
  - `Irodori v2`
  - `Irodori v3`
- 送信は常に短い 1 チャンクのみ（全文一括送信しない）
- キャッシュ再生
  - `Read`: 先頭チャンク（chunk 0）を読む。生成済みなら再生成しない
  - `Next`: 次チャンクを 1 つ読む
  - `Regen`: 現在チャンクを強制再生成
  - `Replay`: 最後に再生した音声を再生成せず再生
  - `Auto`: 最新返答の chunk 0 だけを1回自動送信

## ワークフロー

- v2 workflow: `local-api/reference/tts_e2e_irodori.json`
- v3 workflow: `D:/ComfyUI_TTS_E2E_SANDBOX/ComfyUI/user/default/workflows/tts_e2e_irodori_v3.json`

## 設定

`local-api/config.local.json` で `voiceProfiles` を使います（`voiceProfiles` がある場合はこちらを優先）。

- `defaultVoiceProfile`: 既定profile
- `voiceProfiles.irodori-v2`
- `voiceProfiles.irodori-v3`

互換のため、従来のトップレベル設定（`voiceProfile`, `referenceAudioPath`, `workflowPath`, `workflowPatch`）も引き続きサポートします。

## キャッシュキー

profile衝突回避のため、拡張のキャッシュキーは以下要素を含みます。

- `voiceProfile`
- `messageKey`
- `chunkIndex`
- 正規化済みチャンク本文

## 起動

```cmd
run-voice-stack.cmd
```

最小確認:

- [http://127.0.0.1:8765/health](http://127.0.0.1:8765/health)
- `engine=comfyui_workflow`
- `availableVoiceProfiles` に `irodori-v2`, `irodori-v3`

## 関連ドキュメント

- [startup](docs/startup.md)
- [comfyui-tts-workflow](docs/comfyui-tts-workflow.md)
- [troubleshooting](docs/troubleshooting.md)
- [acceptance](docs/acceptance.md)
