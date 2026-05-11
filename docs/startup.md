# 起動方法

## 通常起動（推奨）

リポジトリ直下で次を実行します。

```cmd
run-qwen-stack.cmd
```

この起動導線では以下を自動実行します。

- `D:\05_ComfyUI_ZImage\run.bat` から ComfyUI を起動（未起動時のみ）
- `http://127.0.0.1:8190/system_stats` 応答待機
- `python local-api/server.py` で local-api 起動（未起動時のみ）
- `http://127.0.0.1:8765/health` 応答待機
- `/health` の `engine=comfyui_qwen3` を確認

補足:

- `.cmd` は `ExecutionPolicy Bypass` をその実行1回だけ利用します
- PowerShell実行ポリシー回避のための指定で、管理者権限への昇格ではありません
- 起動ターミナルを開いている間だけ監視を継続します
- `Ctrl+C` またはターミナルを閉じると、このスクリプトが起動したプロセスのみ停止します
- 既存で起動済みの ComfyUI / local-api は停止しません

## scripts配下から起動したい場合

```cmd
scripts\start-qwen-stack.cmd
```

## 疎通確認

```powershell
.\scripts\smoke-local-api.ps1
```

## 拡張UIの運用

- 拡張の `Read Latest` は同じpreviewなら生成済み音声を再利用する
- `Replay` は最後に再生成功した音声を再生成なしで再生する
- APIの起動/停止は `run-qwen-stack.cmd` 側で行い、拡張UIからは実行しない

## local-api 単体起動（必要時のみ）

```powershell
.\scripts\start-local-api.ps1
```

停止:

```powershell
.\scripts\stop-local-api.ps1
```

## Windowsログオン時自動起動（任意）

```powershell
.\scripts\install-startup-task.ps1
```

解除:

```powershell
.\scripts\uninstall-startup-task.ps1
```
