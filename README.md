# chatgpt-local-voice-bridge

Web版ChatGPTのassistant返答から冒頭preview（最大3行/120文字）だけを抽出し、
ComfyUI/Qwen3-TTS Voice Cloneで音声生成して再生する **Qwen3専用** リポジトリです。

## このリポジトリの前提

- エンジンは `comfyui_qwen3` のみ
- 参照音源: `local-api/reference/voice.wav`
- 参照文字起こし: `local-api/reference/voice.txt`
- workflow: `local-api/workflows/qwen3_clone_api.json`
- Qwen生成パラメータは workflow JSON 側で管理
- Python側は本文・保存名・参照情報のみ注入

## セットアップ

1. 参照音源を配置
- `local-api/reference/voice.wav`
- `local-api/reference/voice.txt`

2. ComfyUI workflow を配置
- `local-api/workflows/qwen3_clone_api.json`

3. 必要ならローカル設定を作成（Git管理外）
- `local-api/config.local.json`
- 例: `local-api/config.qwen3.example.json`
 - 既定URLは `http://127.0.0.1:8190`（ComfyUI）

4. 通常起動（推奨）
```cmd
run-qwen-stack.cmd
```

- PowerShell実行ポリシーで `.ps1` がブロックされる環境でも `.cmd` から起動できます
- `ExecutionPolicy Bypass` は `run-qwen-stack.cmd` 実行時の1回だけです
- これは権限昇格ではありません（管理者化しません）
- ComfyUIは `D:\05_ComfyUI_ZImage\run.bat` から起動します
- ComfyUI `http://127.0.0.1:8190/system_stats` と local-api `http://127.0.0.1:8765/health` が通るまで待機します
- 起動ターミナルを閉じるか `Ctrl+C` で、このスクリプトが起動したプロセスだけ停止します
- 既存で起動済みの ComfyUI / local-api は勝手に停止しません

5. API手動起動（必要時のみ）
```powershell
.\scripts\start-local-api.ps1
```

6. API疎通
```powershell
.\scripts\smoke-local-api.ps1
```

7. Chrome拡張を読み込み
- `chrome://extensions` → デベロッパーモードON
- `extension/` を読み込む

8. ChatGPTでE2E確認
- `https://chatgpt.com/` を開く
- 「最新を読む」または自動検知で冒頭previewのみ送信
- Qwen3音声が再生される

## Native Messaging（任意）

拡張から API Start/Stop を使う場合:

```powershell
.\scripts\install-native-host.ps1 -ExtensionId <拡張ID>
```

## 完了条件

完了条件は **Qwen3 E2E成功** です。
詳細: [docs/acceptance.md](docs/acceptance.md)

## 主要ドキュメント

- [セットアップ](docs/setup.md)
- [起動方法](docs/startup.md)
- [Qwen3/ComfyUI](docs/qwen3-comfyui.md)
- [参照音源](docs/reference-audio.md)
- [トラブルシュート](docs/troubleshooting.md)
- [受け入れ条件](docs/acceptance.md)
- [workflow運用](local-api/workflows/README.md)
