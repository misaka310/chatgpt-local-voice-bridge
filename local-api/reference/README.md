# Reference Audio

`voice.wav` と `voice.txt` をこのフォルダに置いてください。

- `voice.wav`: 参照音声ファイル
- `voice.txt`: 参照音声の文字起こし
- これらの実ファイルは `.gitignore` で除外し、Gitにコミットしません
- `engine=comfyui_qwen3` 時は、必要に応じて workflow ノードへこのパスを注入します
- 既存workflowが固定の参照音源を持っている場合は、このファイルが無くても動作します
