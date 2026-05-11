# Reference Audio

Qwen3/ComfyUI 実行時に使用する参照データです。

- `voice.wav`: 参照音源
- `voice.txt`: 参照文字起こし

運用ルール:

- 実ファイルはGitにコミットしない
- `server.py` は生成前に `voice.wav` を ComfyUI input へコピーする
- `server.py` は `voice.txt` を `Qwen3VoiceClone.inputs.ref_text` へ注入する
