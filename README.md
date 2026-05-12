# chatgpt-local-voice-bridge

Web版ChatGPTのassistant返答から冒頭preview（最大2行/80文字）だけを抽出し、  
ComfyUI workflowで音声生成して再生するローカルブリッジです。

## 現在の標準プロファイル

- engine: `comfyui_workflow`
- voice profile: `irodori`
- 参照音源: `local-api/reference/voice_irodori.wav`
- workflow JSON: `local-api/reference/tts_e2e_irodori.json`
- ComfyUI起動バッチ: `D:/ComfyUI_TTS_E2E_SANDBOX/start_comfyui_tts_sandbox.bat`

## 起動

推奨:

```cmd
run-voice-stack.cmd
```

互換ラッパー:

```cmd
run-qwen-stack.cmd
```

## Chrome拡張の操作

- `Auto`: 自動読み上げON/OFF
- `Read`: 最新assistant応答のpreviewを読む（キャッシュがあれば再生成しない）
- `Regen`: 最新assistant応答のpreviewを強制再生成して読む
- `Replay`: 最後に再生成功した音声を再生成なしで再生
- `Stop`: 再生停止

送信は常に冒頭previewのみです。全文は送信しません。

## 設定ファイル

- Git管理: `local-api/config.example.json`, `local-api/voices/irodori.example.json`
- Git管理外: `local-api/config.local.json`

`config.local.json` では少なくとも以下を設定してください。

- `referenceAudioPath: ./reference/voice_irodori.wav`
- `workflowPath: ./reference/tts_e2e_irodori.json`
- `comfyui.startupBat: D:/ComfyUI_TTS_E2E_SANDBOX/start_comfyui_tts_sandbox.bat`

## 主要ドキュメント

- [起動方法](docs/startup.md)
- [ComfyUI workflow運用](docs/comfyui-tts-workflow.md)
- [参照音源](docs/reference-audio.md)
- [トラブルシュート](docs/troubleshooting.md)
- [受け入れ条件](docs/acceptance.md)
