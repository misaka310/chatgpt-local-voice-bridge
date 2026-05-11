# 起動方法

## 手動起動

```powershell
cd <repo-root>
.\scripts\start-local-api.ps1
```

## 疎通確認（確認専用）

```powershell
cd <repo-root>
.\scripts\smoke-local-api.ps1
```

`windows_sapi` / `mock_wav` は経路確認用途です。  
最終受け入れは `comfyui_qwen3` で実施してください。

## Qwen3最終運用

1. ComfyUIを起動
2. `local-api/reference/voice.wav` を配置
3. `local-api/reference/voice.txt` を配置
4. `local-api/workflows/qwen3_clone_api.json` を配置
5. `local-api/config.local.json` を `engine=comfyui_qwen3` に設定（例: `config.qwen3.example.json`）
6. API再起動
7. `/health` が `engine=comfyui_qwen3` を返すことを確認

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
