# アーキテクチャ

このリポジトリは、ChatGPTの新しいassistant返答を検知し、PC上のIrodori v3 direct APIで冒頭プレビューを読み上げるChrome / Brave拡張とWindows常駐アプリです。通信は127.0.0.1のローカルAPIだけを使用します。

## 役割

- `LocalVoiceBridge.exe`: 既存の`local-api/.venv`と`pythonw.exe`を使い、通知領域アプリを起動する小さなランチャー
- `local-api/tray_controller.py`: Windows小窓、デスクトップペット、APIプロセス、通知領域、自動起動を管理
- `local-api/control_panel.py`: `Ref`、`Volume`、`Auto`、`Next`、`Regen`、`Replay`、状態、現在文章、キュー数を表示する常時最前面の小窓
- `local-api/control_state.py`: 小窓設定、拡張機能の状態、1回だけ消費する操作コマンドを保存・仲介
- `local-api/desktop_pet.py`: Windowsデスクトップ上のペット1体の表示、左ドラッグ移動、ダブルクリック通知を担当
- `extension/content.js`: 各ChatGPTタブの返答検知、プレビュー作成、音声再生を担当。Chrome内に操作パネルやペットは表示しない
- `extension/background.js`: 全ChatGPTタブ共通の再生キュー、ローカルAPI呼び出し、外部パネル同期、音声再生ホストの選択を担当
- `local-api/server.py`: Irodori v3 direct音声生成、音声配信、参照音声一覧、外部パネルAPI、ペット選択同期を担当
- `local-api/conversation_controller.py`: 右Ctrl＋`＼ / _`の録音状態、ローカルSTT、ChatGPT送信に加え、対応するYouTube Dictation Pause Controlへの入力元別状態通知を担当

## Windows Local Voice小窓

小窓に表示する日常操作は次だけです。

- `Ref`
- `Volume`
- `Auto`
- `Next`
- `Regen`
- `Replay`

`Voice`はIrodori v3 direct固定です。小窓はデスクトップペットのダブルクリック、または通知領域の`Show Local Voice panel`から表示・非表示を切り替えます。×は終了ではなく非表示です。位置は`local-api/runtime/control-panel-window.json`へ保存します。

小窓と拡張機能は次のloopback APIで同期します。

```text
GET  /v1/control-panel
GET  /v1/control-panel/poll?after=<command-id>
POST /v1/control-panel/settings
POST /v1/control-panel/command
POST /v1/control-panel/state
```

設定は永続化されます。Next、Regen、Replay、Stopのコマンドは拡張機能が取得した時点で消費され、Chrome再起動後に古い操作が再実行されません。

## 返答検知と全タブAuto

1. 開いている各ChatGPTタブが`background.js`へ登録されます。
2. 各`content.js`が既存assistant返答を基準として記録します。
3. 外部小窓で`Auto`をオンにすると、すべての登録済みChatGPTタブが基準を作り直します。
4. その後で各タブへ新しく表示されたassistant返答を検知します。
5. 各タブの最大2行・80文字の冒頭プレビューを1つの共通キューへ追加します。
6. 共通キューの順番で1件ずつ読み上げます。

Autoの対象は、最後に触った1タブだけではありません。開いている全ChatGPTタブです。`思考中`、`考え中`、`Thinking`、`画像を分析しています`だけの途中状態と、Autoをオンにする前から表示されていた返答は読みません。

## 音声生成と再生

```text
各ChatGPT content.js
  -> background.js の共通キュー
  -> POST http://127.0.0.1:8717/v1/speak
  -> GET  http://127.0.0.1:8717/audio/<file>
  -> 登録済みChatGPTタブの Audio 要素
```

`uiOwnerTabId`は音声を再生するブラウザタブとフォーカス由来の手動操作先を決める内部値です。Autoの検出対象を制限する値ではありません。分割表示の定期通知だけでは所有タブを移動せず、実際のフォーカス・ポインター操作でのみ更新します。

## YouTube停止状態の直接通知

マイク会話モードの低レベルキーボードフックは、録音開始・終了を最初に確定できる唯一の経路です。別プロセスで同じキーを再監視せず、次の通知を専用executorから送ります。

```text
right Ctrl + VK_OEM_102 start/stop
  -> conversation_controller.py
  -> POST http://127.0.0.1:17654/state
     {"active": true|false, "source": "local-voice-bridge"}
  -> YouTube Dictation Pause Controlが他の入力元とOR集約
```

通知は任意連携です。接続失敗やタイムアウトは録音・文字起こし・送信を失敗させません。無効化と正常終了時は、残留activeを避けるため`false`を送信します。

## Refとデスクトップペット

外部小窓で`Ref`を変更すると、同じIDを次へ送ります。

```text
POST http://127.0.0.1:8717/v1/desktop-pet
```

空、`none`、旧`qwen`系値、不正なパス形式は`placeholder`として扱います。指定IDの素材がない場合、デスクトップ側が利用可能な既定素材へフォールバックします。

ペットの操作は次だけです。

- 左ドラッグ: 位置を移動・保存
- 左ダブルクリック: Windows Local Voice小窓を表示・非表示
- シングルクリック、右クリック: 何もしない
- ドラッグ直後のダブルクリック: 誤操作防止のため無効

ペットの位置と選択IDは`local-api/runtime/desktop-pet-settings.json`へ保存します。

## 通知領域と起動

通常入口は`LocalVoiceBridge.exe`です。EXEは`pythonw.exe local-api/tray_controller.py`を非表示で起動します。

通知領域は、外部小窓の表示・非表示、状態確認、再起動、フォルダ表示、自動起動、再セットアップ、終了を担当します。ペット専用の表示・種類・位置メニューは持ちません。Windowsログイン時の自動起動もEXEを直接指定します。

`start-voice-bridge.vbs`は既存利用者向けにEXEへ転送するだけの互換ファイルです。

## 保存する設定

Chrome側:

- AutoのON / OFF
- 127.0.0.1のAPI URLとhealth URL
- Ref ID
- 音量
- プレビュー判定の内部値

Windows側:

- 外部小窓の設定と位置
- ペットの選択IDと位置
- 拡張機能から受け取った直近状態

Voice、Tab、Petの独立選択設定は保存しません。

## テスト

- Pythonテスト: loopback境界、外部状態ストア、外部Qt小窓、通知領域、ペットのドラッグ・ダブルクリック、ランチャー
- background単体テスト: 全タブ共通キュー、外部設定反映、コマンド重複防止、Ref・ペット同期
- mock E2E: Chrome内パネルなし、外部Auto、Next / Regen / Replay、短文、途中状態除外、複数タブ共通キュー
- real E2E: 専用loopbackポートでIrodori v3 direct、Next、実参照音声・ペット同期、複数タブ共通キュー

エージェント実行のブラウザ検証では`voiceVolume=0`と`--mute-audio`を使用します。
