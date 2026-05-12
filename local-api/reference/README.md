# reference

ComfyUI workflow実行時に使うローカル参照データ置き場です。

- `voice_irodori.wav`: 参照音源（Git管理しない）
- `tts_e2e_irodori.json`: Irodori用workflow JSON（Git管理しない）

`server.py` は実行時に以下のみ差し替えます。

- 読み上げ本文
- 保存名（`filename_prefix` など）
- 必要時のみ参照音源ファイル名
