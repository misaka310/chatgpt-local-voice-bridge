# ComfyUI TTS Workflow

このリポジトリは `comfyui_workflow` エンジンで、ComfyUI workflow JSONを実行します。

## 標準ファイル

- workflow: `local-api/reference/tts_e2e_irodori.json`
- reference audio: `local-api/reference/voice_irodori.wav`
- config example: `local-api/config.example.json`
- voice profile example: `local-api/voices/irodori.example.json`

## 注入ルール（Python側）

`local-api/server.py` が実行時に更新するのは次のみです。

- 本文: workflow内の本文ノード入力（例: `IrodoriTTSSampler.text`）
- 保存名: SaveAudio系入力（例: `SaveAudio.filename_prefix`）
- 参照音源: 参照音源ノード入力（例: `IrodoriTTSReferenceAudio.ref_audio`）

それ以外の seed/model/style/speed/sampling などは workflow JSON 側の値をそのまま使います。

## workflowPatch

注入先は `config.local.json` の `workflowPatch` で上書きできます。
未指定時は `classTypeIncludes` と `inputKeys` の既定候補で自動検出します。

## 参照音源の扱い

- `voice_irodori.wav` の存在確認
- SHA1計算
- 参照音源ノードが存在する場合のみ `inputDir` へ `voice_irodori-<sha12>.wav` としてコピー
- workflowへコピー後ファイル名を注入
- 参照音源ノードがないworkflowでは注入せず `referenceAudioUsed=false`
