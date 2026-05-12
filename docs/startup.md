# Startup

## 1. 起動

```cmd
run-voice-stack.cmd
```

または

```cmd
scripts\start-voice-stack.cmd
```

## 2. API ヘルス確認

`http://127.0.0.1:8765/health` を確認し、次を満たすこと。

- `ok=true`
- `engine=comfyui_workflow`
- `defaultVoiceProfile=irodori-v2`
- `availableVoiceProfiles` に `irodori-v2` と `irodori-v3`

## 3. 拡張UI確認

Local Voice パネル:

- Voice select: `Irodori v2` / `Irodori v3`
- Buttons: `Auto`, `Read`, `Next`, `Regen`, `Replay`, `Stop`

## 4. ボタン挙動

- `Read`: chunk 0 を読む（キャッシュがあれば再生成しない）
- `Next`: 現在位置の次チャンクを 1つ読む。末尾は `No more text`
- `Regen`: 現在チャンクを強制再生成
- `Replay`: 最後の音声を再生成せず再生
- `Auto`: 最新assistant返答の chunk 0 だけを 1 回送信

## 5. チャンク仕様

既定:

- `previewMaxLines: 2`
- `previewMaxChars: 80`
- `previewMinChars: 25`

コードブロック除外、markdown記号を落とし、句読点（`。！？.!?`）優先で自然に分割します。
