# アーキテクチャ

このリポジトリは、ChatGPT の返答を検知し、PC 上のローカル音声合成 API で読み上げる Chrome / Brave 拡張です。

中心方針は、ローカル完結です。ChatGPT 画面上の返答テキストをブラウザ内で検知し、localhost の API に送り、生成された音声を現在の ChatGPT タブで再生します。

## 構成

- `extension/manifest.json`: 拡張の設定、content script、background service worker、権限、アイコン、ペット用アセットを定義します。
- `extension/content.js`: ChatGPT のページ上で動きます。返答の検知、テキスト整形、パネル UI、ペット UI、音声再生を担当します。
- `extension/background.js`: タブ管理、再生キュー、ローカル API 呼び出し、再生状態の配信を担当します。
- `extension/options.html` / `extension/options.js`: 拡張の設定画面を担当します。
- `local-api/`: 音声生成 API を置く領域です。
- `tests/e2e/`: Playwright による E2E テストです。

## 実行時の流れ

### 1. タブ登録

ChatGPT のタブが開かれると、`content.js` が `background.js` にタブを登録します。

`background.js` は開いている ChatGPT タブを管理し、どのタブに操作パネルを表示するかを決めます。操作パネルとペット UI は、選ばれたタブだけに表示します。

### 2. 返答の検知

`content.js` は `MutationObserver` でページの変化を監視します。

assistant の返答が追加されると、その DOM からテキストを取り出します。起動前から画面にあった返答は読み上げ対象にしません。Auto を ON にした瞬間に過去の返答を読み始めないようにするためです。

### 3. テキスト整形と分割

読み上げ前に、コードブロック、ボタン、メニュー、入力欄など、読み上げに不要な要素を取り除きます。

その後、テキストを整形し、短い preview chunk に分割します。

現在の Auto は全文読み上げではありません。

- Auto は最初の preview chunk だけを読みます。
- preview は既定で最大 2 行 / 80 文字です。
- `Next` で次の chunk を手動再生します。
- `Regen` で現在の chunk を再生成・再生します。

長い返答を勝手に全文読み上げしないため、この動作にしています。

### 4. キュー投入と音声生成

`content.js` が検知した chunk は `background.js` に送られます。

`background.js` は Auto、Next、Regen、Replay の操作に応じて再生 item をキューに入れ、ローカル API を呼びます。

```text
POST http://127.0.0.1:8717/v1/speak
```

API は音声ファイルの URL を返します。

### 5. 再生

`background.js` は、操作パネルを持つタブの `content.js` に再生を依頼します。

`content.js` は音声を取得して Blob URL に変換し、`Audio` 要素で再生します。再生が終わると、結果を `background.js` に返します。

## 状態管理

`background.js` が持つ状態:

- 開いている ChatGPT タブ
- 操作パネルを表示するタブ
- 再生対象のタブ
- 再生キュー
- 現在再生中の item
- 最後に再生した item
- ステータス文言

`content.js` が持つ状態:

- DOM 監視
- 検知済みメッセージ
- 操作パネル DOM
- ペット UI DOM
- 現在の `Audio` 要素
- 再生 token

Chrome storage に保存する設定:

- Auto の ON / OFF
- ローカル API URL
- health URL
- voice profile
- reference voice id
- 音量
- パネル位置
- ペット位置

## ローカル API

拡張は、次の endpoint を持つローカル API を前提にしています。

```text
GET  /health
POST /v1/speak
GET  /audio/<file>
```

`/health` は API が起動しているかを確認します。

`/v1/speak` はテキストから音声を生成し、音声 URL を返します。

`/audio/<file>` は生成された WAV ファイルを返します。

## テスト

E2E テストは `tests/e2e/` にあります。

テストでは、Chromium に unpacked extension を読み込み、偽の ChatGPT ページを表示し、assistant 返答 DOM を追加して、パネルが再生成功状態まで進むことを確認します。

CI では、本物の Irodori ランタイムではなく、軽量な localhost のモック音声 API を使います。大きなモデルファイルを落とさずに、拡張側の再生フローだけを確認するためです。

## 現在の実装メモ

`content.js` は現在、DOM 検知、テキスト整形、chunk 分割、パネル UI、ペット UI、再生処理を 1 ファイルで持っています。

これは今は意図的にそのままにしています。分割すると壊れる可能性があるため、先に E2E テストを安定させてから分割する方針です。

## 既知の制限

- ChatGPT 側の DOM 構造が変わると検知が壊れる可能性があります。
- Auto は全文読み上げではなく preview のみを読みます。
- CI はモック音声 API を使うため、実際の音質は確認しません。
- 実運用ではローカル API が起動している必要があります。
- 現状は個人利用向けです。
