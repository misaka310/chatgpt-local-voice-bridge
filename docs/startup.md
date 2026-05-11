# 起動方法

## 手動起動

```powershell
cd <repo-root>
.\scripts\start-local-api.ps1
```

## 疎通確認

```powershell
cd <repo-root>
.\scripts\smoke-local-api.ps1
```

ComfyUI が `8190` で起動している環境では、`local-api/config.local.json` の
`comfyui.baseUrl` を `http://127.0.0.1:8190` に設定してください。

## 停止

```powershell
cd <repo-root>
.\scripts\stop-local-api.ps1
```

## Native host導入（拡張Start/Stop用）

1. `chrome://extensions` で拡張ID確認
2. 実行:

```powershell
.\scripts\install-native-host.ps1 -ExtensionId <拡張ID>
```

3. ChatGPTタブ再読み込み
4. パネルの `Start API` / `Stop API` / `Health` を利用

## Windowsログオン時自動起動（任意）

```powershell
.\scripts\install-startup-task.ps1
```

解除:

```powershell
.\scripts\uninstall-startup-task.ps1
```
