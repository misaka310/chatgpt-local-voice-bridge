# 受け入れ条件

## 必須前提

- ComfyUIが起動している
- `local-api/reference/voice_irodori.wav` が存在する
- `local-api/reference/tts_e2e_irodori.json` が存在する
- `engine` が `comfyui_workflow`
- `voiceProfile` が `irodori`

## API E2E

- `run-voice-stack.cmd` または `scripts/start-voice-stack.cmd` で起動
- `/health` が成功し、`engine=comfyui_workflow` を返す
- `scripts/smoke-local-api.ps1` で `/v1/speak` 成功
- ComfyUI `/prompt` 実行と `/history/{prompt_id}` 成功
- 生成音声が `local-api/runtime/audio/` にコピーされる
- `/audio/<filename>` が再生できる

## 拡張 E2E

- 初期状態 `Auto OFF`
- `Read` で冒頭preview（最大2行/80文字）だけ送信
- 同じpreviewで再度 `Read` しても再生成しない
- `Regen` で強制再生成される
- `Replay` は最後の音声を再生成なしで再生
- `Stop` で再生停止
- 折りたたみ/展開が可能
- パネル位置と折りたたみ状態がリロード後も保持される

## debug 出力

- `local-api/runtime/debug/<requestId>/` に以下が保存される
- `request.json`
- `prompt.json`
- `summary.json`
- `history.json`
- `summary.json` に `voiceProfile`, `engine`, `workflowPath`, `referenceAudioPath`, `referenceAudioHash`, `referenceAudioUsed`, `textHash`, `patchedPromptHash`, `ttsInputHash` が含まれる
