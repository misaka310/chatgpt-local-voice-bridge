# 起動方法

## 通常起動（推奨）

```cmd
run-voice-stack.cmd
```

この導線で以下を自動実行します。

- `D:/ComfyUI_TTS_E2E_SANDBOX/start_comfyui_tts_sandbox.bat` からComfyUI起動（未起動時のみ）
- `http://127.0.0.1:8288/system_stats` 応答待機
- `python local-api/server.py` でlocal-api起動（未起動時のみ）
- `http://127.0.0.1:8765/health` 応答待機
- `/health` の `engine=comfyui_workflow` と `voiceProfile=irodori` を確認

互換ラッパー:

```cmd
run-qwen-stack.cmd
```

## scripts配下から起動する場合

```cmd
scripts\start-voice-stack.cmd
```

互換ラッパー:

```cmd
scripts\start-qwen-stack.cmd
```

## 疎通確認

```powershell
.\scripts\smoke-local-api.ps1
```

## 拡張UI運用

- 初期状態は `Auto OFF`
- `Read` は同じpreviewなら生成済み音声を再利用
- `Regen` はキャッシュを無視して強制再生成
- `Replay` は最後の音声を再生成なしで再生
- `Stop` は再生停止
- 送信対象は冒頭previewのみ（最大2行/80文字）
- 全文送信しない

## local-api単体起動（必要時のみ）

```powershell
.\scripts\start-local-api.ps1
```

停止:

```powershell
.\scripts\stop-local-api.ps1
```
