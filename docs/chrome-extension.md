# Chrome拡張

## 役割

- ChatGPTのassistant応答DOMを監視
- 冒頭preview（最大2行/80文字）を抽出
- 1応答につき1回だけ `/v1/speak` へ送信
- ChatGPT全文は送信しない
- 返却された `/audio/...` を取得して再生

## パネル

- 折りたたみ時: `Voice · Ready` の小型バー
- 展開時: `Auto / Read / Regen / Replay / Stop`
- 初期状態は `Auto OFF`
- 位置と折りたたみ状態は `chrome.storage.local` に保存

## ボタン仕様

- `Read`: キャッシュがあれば再生成せず再生
- `Regen`: キャッシュを無視して強制再生成
- `Replay`: 最後に再生成功した音声を再生
- `Stop`: 再生停止

## Native host導入（任意）

```powershell
.\scripts\install-native-host.ps1 -ExtensionId <拡張ID>
```
