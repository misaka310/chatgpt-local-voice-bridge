# reference

ComfyUI workflow 実行時に使うローカル参照データ置き場です。

## voice preset 方式

`/v1/voice-presets` と `/v1/speak` の `voicePreset` は次の構成を参照します。

```text
17_chatgpt-local-voice-bridge/
  local-api/
    reference/
      voice-presets/
        <preset-id>/
          voice.wav
          voice.txt
```

- `voice.wav`: 参照音声ファイル
- `voice.txt`: `voice.wav` で実際に読まれている文章の文字起こし

`voice.txt` には preset 名ではなく、参照音声の発話内容を書いてください。

## 既存参照音声との関係

- `local-api/reference/voice_irodori.wav` など既存ファイルは他用途のため残します。
- 既存ファイルの上書き・移動・削除はしません。
- `voicePreset` 指定時だけ、リクエスト単位で `voice.wav` / `voice.txt` を使います。
