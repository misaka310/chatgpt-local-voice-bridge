# ComfyUI TTS Workflow

このプロジェクトは `comfyui_workflow` エンジンで ComfyUI workflow JSON を実行します。

## Voice Profile と workflow

- `irodori-v2`
  - workflow: `local-api/reference/tts_e2e_irodori.json`
- `irodori-v3`
  - workflow: `D:/ComfyUI_TTS_E2E_SANDBOX/ComfyUI/user/default/workflows/tts_e2e_irodori_v3.json`

`/v1/speak` は `voiceProfile`（または `workflowVersion`）で profile を解決します。

- 未指定: `defaultVoiceProfile`
- 不明な profile/version: `400`

## config 設計

`voiceProfiles` 方式（推奨）:

- `defaultVoiceProfile`
- `voiceProfiles.<profileId>.referenceAudioPath`
- `voiceProfiles.<profileId>.workflowPath`
- `voiceProfiles.<profileId>.workflowPatch`

互換性:

- 従来のトップレベル設定（`voiceProfile`, `referenceAudioPath`, `workflowPath`, `workflowPatch`）は引き続き有効
- ただし `voiceProfiles` がある場合は `voiceProfiles` を優先

## /health

`/health` は以下を返します。

- `engine`
- `defaultVoiceProfile`
- `availableVoiceProfiles`（`id`, `label`）
- 既定profileの `workflowPath` / `referenceAudioPath`

## debug summary

`local-api/runtime/debug/<requestId>/summary.json` に少なくとも次が出力されます。

- `voiceProfile`
- `workflowPath`
- `textHash`
- `ttsInputHash`
- `referenceAudioHash`
- `audioPath`

## 出力ファイル名

音声ファイル名は profile を含みます。

- 例: `chatgpt-irodori-v3-<requestId>-<hash>.flac`
