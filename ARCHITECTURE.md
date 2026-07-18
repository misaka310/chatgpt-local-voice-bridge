# アーキテクチャ

このリポジトリは、ChatGPTの新しいassistant返答を検知し、PC上のIrodori v3 direct APIで冒頭プレビューを読み上げるChrome / Brave拡張とWindows常駐アプリです。

通信は127.0.0.1のローカルAPIだけを使用します。

## 役割

- `ChatGPTLocalVoiceBridge.exe`: 既存の`local-api/.venv`と`pythonw.exe`を使い、通知領域アプリを起動するだけの小さなランチャー
- `local-api/tray_controller.py`: APIの状態確認、再起動、フォルダ表示、自動起動、再セットアップ、終了を担当
- `local-api/desktop_pet.py`: Windowsデスクトップ上のペット1体の表示と左ドラッグ移動を担当
- `extension/content.js`: ChatGPT返答の検知、プレビュー作成、Local Voiceパネル、音声再生を担当
- `extension/background.js`: ChatGPTタブの所有権、再生キュー、ローカルAPI呼び出し、状態配信を担当
- `local-api/server.py`: Irodori v3 directによる音声生成、参照音声一覧、音声配信、デスクトップペット選択の同期を担当

拡張機能の別設定画面は持ちません。日常的な音声操作はChatGPT上のLocal Voiceパネルだけで行います。

## Local Voiceパネル

パネルに表示する操作は次だけです。

- `Ref`
- `Volume`
- `Auto`
- `Next`
- `Regen`
- `Replay`

`Voice`はIrodori v3 direct固定です。`Tab`は現在アクティブな登録済みChatGPTタブをbackgroundが自動選択します。`Pet`専用設定はなく、デスクトップペットは`Ref`と自動連動します。

パネルはバーへ折りたためます。展開状態と位置は`chrome.storage.local`へ保存します。

## 返答検知とAuto

1. ChatGPTタブが`background.js`へ登録されます。
2. `content.js`が既存assistant返答を基準として記録します。
3. `Auto`をオンにすると、その時点でもう一度基準を作り直します。
4. その後で新しく表示されたassistant返答だけを検知します。
5. 最大2行・80文字の冒頭プレビューを1回だけキューへ送ります。

Autoは返答全文を自動再生しません。`Next`は次のチャンク、`Regen`は現在のチャンクの再生成、`Replay`は生成済み音声の再再生です。

## タブ所有権

`background.js`は登録済みChatGPTタブを保持します。`chrome.tabs.onActivated`と登録時の`sender.tab.active`を使い、現在表示しているタブだけにLocal Voiceパネルを表示します。

パネルからの`Next`、`Regen`などは、メッセージ送信元のタブを最優先に対象とします。画面上のTab選択欄はありません。

## 音声生成と再生

```text
content.js
  -> background.js
  -> POST http://127.0.0.1:8717/v1/speak
  -> GET  http://127.0.0.1:8717/audio/<file>
  -> content.js の Audio 要素
```

APIが返した音声はbackground経由で取得し、現在のLocal Voiceパネルを持つタブで再生します。再生完了はbackgroundへ返され、キューの次項目へ進みます。

## Refとデスクトップペット

`Ref`変更時、content scriptは同じIDを次へ送ります。

```text
POST http://127.0.0.1:8717/v1/desktop-pet
```

空、`none`、旧`qwen`系値、不正なパス形式は`placeholder`として扱います。指定IDのペット素材がない場合、デスクトップ側が利用可能な既定素材へフォールバックします。

以前のブラウザ設定`petMode`、`selectedPetId`、`petPosition`は移行時に削除します。ペットの位置と実行中の選択IDは`local-api/runtime/desktop-pet-settings.json`へ保存します。

デスクトップペットはクリック、ダブルクリック、右クリックに機能を持ちません。左ドラッグで位置が変わった場合だけ保存します。

## 通知領域と起動

通常入口は`ChatGPTLocalVoiceBridge.exe`です。EXEはUIや設定を持たず、`pythonw.exe local-api/tray_controller.py`を非表示で起動します。

通知領域はサービス管理だけを担当します。ペットの表示、種類、位置、最前面を操作するメニューはありません。Windowsログイン時の自動起動もEXEを直接指定します。

`start-voice-bridge.vbs`は既存利用者向けにEXEへ転送するだけの互換ファイルです。

## 保存するブラウザ設定

- AutoのON / OFF
- 127.0.0.1のAPI URLとhealth URL
- Ref ID
- 音量
- パネルの展開状態と位置
- プレビュー判定の内部値

Voice、Tab、Petの選択設定は保存しません。

## テスト

- Pythonテスト: loopback境界、API、通知領域、Qtデスクトップペット、ランチャー周辺
- background単体テスト: Ref維持、明示的な空Ref、Next / Regen、デスクトップペットAPI転送
- mock E2E: Auto基準、最大2行・80文字、4操作、簡潔なパネル、折りたたみ復元、旧Pet設定移行、Ref連動、アクティブタブ所有権
- real E2E: Irodori v3 direct、実参照音声、生成音声取得、Ref連動、複数タブ

エージェント実行のブラウザ検証では`voiceVolume=0`と`--mute-audio`を使用します。
