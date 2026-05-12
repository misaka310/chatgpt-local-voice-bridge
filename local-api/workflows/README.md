# workflows

## 実運用workflow

- ファイル: `local-api/workflows/qwen3_clone_api.json`
- 由来: `misaka310/32_dotitao-room` の実績workflow構成を移植
- 形式: ComfyUI API形式 JSON

## ノード構成（想定）

- `Qwen3Loader`
- `LoadAudio`
- `Qwen3VoiceClone`
- `SaveAudio`

## Git管理方針

- `qwen3_clone_api.json` は標準workflowとしてGit追跡する
- 構造説明用として `qwen3_clone_api.example.json` を維持する
- 個人調整版は `qwen3_clone_api.local.json` として作成し、Git管理しない
- 個人調整版を使う場合は `config.local.json` の `comfyui.workflowPath` で切り替える

## 実行時注入（server.py）

- `Qwen3VoiceClone.inputs.text`
- `Qwen3VoiceClone.inputs.ref_text`
- `LoadAudio.inputs.audio`
- `SaveAudio.inputs.filename_prefix`

## workflow側で管理する項目

- seed
- generation_mode
- language
- max_new_tokens
- ref_audio_max_seconds
- sampling/temperature/speed 等の生成パラメータ
- 声質に関わる設定
