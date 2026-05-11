# workflows

`qwen3_clone_api.json` は、ComfyUIから **API形式** で保存した Qwen3 Voice Clone workflow です。
実運用では `local-api/workflows/qwen3_clone_api.json` に配置してください。

## Git管理方針

- workflowに個人環境パスや参照音源情報が含まれる場合は **Gitに入れない**
- 共有用には `qwen3_clone_api.example.json` を使う
- 実workflowをGit管理しない運用でも問題ありません

## Python側（server.py）が差し替える項目

- `Qwen3VoiceClone.inputs.text`
- `SaveAudio` 系ノードの保存名
- 対応キーが存在する場合の参照音源パス
- 対応キーが存在する場合の参照文字起こしパス

## Python側で管理しない項目

以下のQwen生成パラメータは workflow JSON 側で管理します。

- seed
- temperature
- speed
- max tokens
- sampling系設定
- 声質に関わるノード設定

## example JSON について

`qwen3_clone_api.example.json` は **実行可能保証のない参考例** です。
実運用では必ずComfyUIで作成した実workflowをAPI形式で保存して配置してください。
