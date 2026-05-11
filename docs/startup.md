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

## 拡張から起動する場合（Native host）

1. `chrome://extensions` で拡張IDを確認
2. Native host登録
```powershell
.\scripts\install-native-host.ps1 -ExtensionId <拡張ID>
```
3. ChatGPTタブを再読み込み
4. 右下パネルの `Start API` を押す

未導入時はパネルに手動起動案内が表示されます。

## 停止

- 手動停止
```powershell
.\scripts\stop-local-api.ps1
```
- Native host導入済みならパネルの `Stop API`

## Windowsログオン時に自動起動

```powershell
.\scripts\install-startup-task.ps1
```

アンインストール:

```powershell
.\scripts\uninstall-startup-task.ps1
```
