# workflows

`engine=comfyui_qwen3` のとき、ComfyUIからAPI形式で保存した workflow を
`qwen3_clone_api.json` としてこのフォルダへ配置してください。

本ブリッジは以下を反映します。

- `Qwen3VoiceClone.inputs.text` に本文注入
- `SaveAudio` 系ノードの保存名を一意化
- 対応キーがある場合、`referenceAudioPath` / `referenceTextPath` のパス注入

固定しておくもの:

- モデル
- 音色・速度
- seed
- 参照音源を固定運用する場合のノード構成
