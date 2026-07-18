# 操作と検証

## 通常の使い方

1. `ChatGPTLocalVoiceBridge.exe`を起動します。
2. 通知領域で`Status: Ready`または`Status: Ready (existing)`を確認します。
3. Chrome / BraveでChatGPTを開き、Local Voiceバーをクリックしてパネルを展開します。
4. 必要に応じて`Ref`と`Volume`を設定し、`Auto`をオンにしてから新しいメッセージを送ります。
5. 新しい返答の冒頭プレビューが一度だけ再生されることを確認します。

日常的な音声操作はLocal Voiceパネルだけで行います。パネルには`Ref`、`Volume`、`Auto`、`Next`、`Regen`、`Replay`だけを表示します。`Voice`はIrodori v3 direct固定、操作対象タブは現在表示しているChatGPTタブを自動判定し、デスクトップペットは`Ref`と自動連動します。

状態表示の下には、現在生成中または再生中の文章プレビューを1行で表示します。長い文章は省略表示され、マウスを重ねると全文を確認できます。

Local Voiceバーをもう一度クリックすると折りたためます。展開・折りたたみ状態とパネル位置はブラウザへ保存され、次回も復元されます。

## 各ボタン

- `Auto`: オンにした後で新しく表示されたassistant返答だけを対象にします。オンにする前から表示されていた返答は読みません。返答全文ではなく、最大2行・80文字の冒頭プレビューだけを一度再生します。
- `Next`: 現在の返答の次のチャンクへ進みます。
- `Regen`: 現在のチャンクを同じ設定で再生成します。
- `Replay`: 再生成せず、直前に生成済みの音声をもう一度再生します。

## 役割の分担

- `ChatGPTLocalVoiceBridge.exe`: アプリを起動するだけ
- 通知領域: 状態確認、再起動、フォルダ表示、自動起動、再セットアップ、終了
- Chrome / BraveのLocal Voiceパネル: 日常の音声操作
- デスクトップペット: 表示と左ドラッグ移動だけ

ペットの通常クリック、ダブルクリック、右クリックでは何も起きません。ペットからChromeやパネルを開く機能はありません。

## GPU不要のデモ

```bat
npm ci
npx playwright install chromium
npm run demo
```

Node.jsとChromiumだけで安全なローカルフィクスチャを開きます。Python、CUDA、GPU、モデル、ChatGPTログインは不要です。実際の拡張機能コードと`scripts/mock-voice-api.js`を使用します。Chromiumを閉じるか`Ctrl+C`を押すと、mock APIと一時ブラウザプロファイルを片付けます。

## 自動テスト

```bat
npm run test:ci
```

`test:ci`は次を検証します。

- APIと音声URLが127.0.0.1のloopbackだけを使用すること
- Chrome内にペット本体が生成されないこと
- パネルに`Voice`、`Tab`、`Pet`欄がなく、`Ref`、`Volume`、4つの操作ボタンがあること
- パネルの展開・折りたたみ状態が保存・復元されること
- 古いペット専用ブラウザ設定が安全に削除または無視されること
- `Ref`がデスクトップペットAPIへ同期され、空または`none`は`placeholder`になること
- Autoをオンにする前から表示されていた返答へ`POST /v1/speak`を送らないこと
- Auto後の新しい返答だけを対象にし、冒頭プレビューが最大2行・80文字であること
- `Next`、`Regen`、`Replay`の既存動作が維持されること
- 複数のChatGPTタブでは、現在アクティブなタブへLocal Voiceパネルと操作対象が切り替わること
- 通知領域にペット用操作がないこと
- デスクトップペットのクリック系操作が無動作で、左ドラッグだけが位置を保存すること

mockの成功は、実Irodoriの音質、GPU使用、将来の実ChatGPT DOMを保証しません。

## 実機Irodoriの確認

```bat
npm run test:e2e:real
```

先に`setup-voice-env.cmd`を完了し、NVIDIA GPU、CUDA、モデルを用意してください。テストは音量0と`--mute-audio`でブラウザを起動し、実際の`/v1/speak`、生成音声、Ref連動、アクティブタブ切り替えを確認します。

ターミナルでサーバーログを直接確認する場合だけ`run-voice-stack.cmd`を使います。通常利用の起動入口ではありません。
