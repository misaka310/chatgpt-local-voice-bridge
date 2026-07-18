# 起動

初回セットアップ後、`start-voice-bridge.vbs`をダブルクリックします。

通常起動ではターミナルは表示されません。Windows右下の通知領域に`ChatGPT Local Voice Bridge`アイコンが表示されます。隠れている場合は、タスクバー右端の上向き矢印を開いてください。

## 通知領域メニュー

- `Status: ...`: APIの現在状態
- `Restart Voice Bridge`: この通知領域アプリが起動したAPIだけを再起動
- `Open controller log`: `local-api/logs/controller.log`を開く
- `Open generated audio folder`: 生成された音声フォルダを開く
- `Open reference voices folder`: 参照音声フォルダを開く
- `Start with Windows`: 現在のユーザーのWindowsログイン時自動起動を切り替える
- `Exit and run environment setup`: APIを停止し、セットアップを表示付きで再実行する
- `Exit`: 通知領域アプリと、そのアプリが所有するAPIを終了する

既に互換APIが起動している場合は`Ready (existing)`と表示し、そのプロセスを勝手に終了しません。

## 状態表示

- `Starting`: API起動中
- `Checking environment`: CUDAとIrodoriの事前確認中
- `Ready`: 通知領域アプリが起動したAPIが正常
- `Ready (existing)`: 別の方法で起動済みの互換APIへ接続中
- `Environment missing`: `.venv`またはサーバーファイルがない
- `CUDA or model unavailable`: CUDA、依存関係、モデルの事前確認に失敗
- `Port 8717 in use`: 別サービスが同じポートを使用中
- `Unhealthy` / `Restarting`: API異常を検出し、復旧処理中

## 成功条件

`http://127.0.0.1:8717/health`で次の状態になれば起動できています。

- `ok=true`
- `runtime=irodori_direct`
- `defaultModel=irodori-v3`

最初の`/v1/speak`は、モデルをGPUメモリへ読み込むため時間がかかります。

## 診断用の前面起動

ターミナルでログを直接確認する場合だけ`run-voice-stack.cmd`を使います。通常利用では使用しません。
