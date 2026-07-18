# 起動

初回セットアップ後、`ChatGPTLocalVoiceBridge.exe`をダブルクリックします。これは既存の`local-api/.venv`を使って通知領域アプリを起動する小さなWindowsランチャーです。

通常起動ではターミナルは表示されません。Windows右下の通知領域に`ChatGPT Local Voice Bridge`アイコンが表示され、デスクトップペットが1体起動します。通知領域アイコンが隠れている場合は、タスクバー右端の上向き矢印を開いてください。

`start-voice-bridge.vbs`は既存利用者向けの互換入口としてのみ残り、内部ではEXEへ転送します。通常起動とWindowsログイン時の自動起動はEXEを使用します。

`.venv`、`pythonw.exe`、`PySide6`、`QtWidgets`、`QtSvg`のいずれかが不足している場合は、`setup-voice-env.cmd`をもう一度実行するよう案内されます。セットアップを再実行すると、既存の音声環境へ必要なQt依存関係が追加されます。

## 通知領域メニュー

通知領域はVoice Bridgeの管理だけを行います。

- `Status: ...`: APIの現在状態
- `Restart Voice Bridge`: この通知領域アプリが起動したAPIだけを再起動
- `Open controller log`: `local-api/logs/controller.log`を開く
- `Open generated audio folder`: 生成された音声フォルダを開く
- `Open reference voices folder`: 参照音声フォルダを開く
- `Start with Windows`: 現在のユーザーのWindowsログイン時自動起動を切り替える
- `Exit and run environment setup`: APIを停止し、セットアップを表示付きで再実行する
- `Exit`: 通知領域アプリ、デスクトップペット、このアプリが所有するAPIを終了する

ペットの表示切り替え、種類選択、位置初期化、常に手前の切り替えは通知領域にはありません。

## デスクトップペットの操作

ペット本体を左ドラッグすると、Windowsデスクトップ上の好きな位置へ移動できます。通常クリック、ダブルクリック、右クリックでは何も起きません。

ペットの種類はChrome / BraveのLocal Voiceパネルにある`Ref`と自動連動します。Chrome内にはペット本体や`Pet`選択欄を表示しません。`Ref=none`または空の場合と、同じIDの素材がない場合は既定ペットへフォールバックします。

設定は`local-api/runtime/desktop-pet-settings.json`へ保存されます。このファイルはローカル専用で、Gitには追加されません。モニター構成やDPIが変わって保存位置が完全に画面外になった場合は、起動時に操作できる位置へ一時補正されます。補正後にユーザーがドラッグした場合だけ新しい位置として保存します。

## 状態表示

- `Starting`: API起動中
- `Checking environment`: CUDAとIrodoriの事前確認中
- `Ready`: 通知領域アプリが起動したAPIが正常
- `Ready (existing)`: 別の方法で起動済みの互換APIへ接続中
- `Environment missing`: `.venv`またはサーバーファイルがない
- `CUDA or model unavailable`: CUDA、依存関係、モデルの事前確認に失敗
- `Port 8717 in use`: 別サービスが同じポートを使用中
- `Unhealthy` / `Restarting`: API異常を検出し、復旧処理中

デスクトップペットは、Voice Bridgeが正常なときに`idle`、異常時に`error`を表示します。Chrome側の実際の音声再生開始・終了を正確に受け取る経路がないため、デスクトップ側で`thinking`、`talking`、`happy`を推測して切り替えることはしません。

## 成功条件

`http://127.0.0.1:8717/health`で次の状態になれば起動できています。

- `ok=true`
- `runtime=irodori_direct`
- `defaultModel=irodori-v3`

最初の`/v1/speak`は、モデルをGPUメモリへ読み込むため時間がかかります。

## Windowsで確認する手順

1. `ChatGPTLocalVoiceBridge.exe`をダブルクリックする
2. 通知領域のアイコンで`Status: Ready`または`Status: Ready (existing)`を確認する
3. Chrome / BraveのLocal Voiceパネルに`Voice`、`Tab`、`Pet`欄がなく、`Ref`、`Volume`、`Auto`、`Next`、`Regen`、`Replay`だけがあることを確認する
4. Local Voiceバーをクリックし、展開・折りたたみと再読み込み後の状態復元を確認する
5. Chrome内にペット本体が表示されていないことを確認する
6. 白い背景と黒い背景の両方で、デスクトップペットの周囲に四角い背景や影がないことを確認する
7. `Ref`を変更し、同じIDのデスクトップペットへ切り替わることを確認する
8. ペットの通常クリック、ダブルクリック、右クリックで何も起きず、左ドラッグだけで移動できることを確認する
9. 通知領域メニューにペット用の重複操作がないことを確認する
10. `Exit`で終了し、再起動後に位置と`Ref`連動したペットが復元されることを確認する

`Exit`は通知領域アプリが起動した`server.py`だけを停止します。`run-voice-stack.cmd`などで先に起動した互換APIへ接続している場合、その外部プロセスは停止しません。

## 診断用の前面起動

ターミナルでログを直接確認する場合だけ`run-voice-stack.cmd`を使います。通常利用では使用しません。
