# Chrome拡張

## 役割

- ChatGPTのassistant応答DOMを監視
- 冒頭preview（最大3行/120文字）を抽出
- 1応答につき1回だけ `/v1/speak` へ送信
- 返却された `/audio/...` を取得して再生

## パネル

- `Health`: API状態確認
- `Start API` / `Stop API`: Native host経由
- `最新を読む`: 最新assistant応答の冒頭previewを手動送信
- `Auto ON/OFF`: 自動送信切替

## Native host未導入時

拡張からPowerShellを直接実行できないため、手動起動案内を表示します。

- 手動起動: `./scripts/start-local-api.ps1`
- 手動停止: `./scripts/stop-local-api.ps1`

## Native host導入

```powershell
.\scripts\install-native-host.ps1 -ExtensionId <拡張ID>
```

解除:

```powershell
.\scripts\uninstall-native-host.ps1
```
