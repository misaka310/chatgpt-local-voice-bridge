# ChatGPT Local Voice Bridge

ChatGPT の assistant 返答を、PC 上でローカル音声読み上げする Chrome / Brave 拡張です。

## できること

- ChatGPT の assistant 返答を検知して読み上げる
- Auto では返答の冒頭 preview だけを読む
- preview の上限は最大 2行 / 80文字
- 返答全文を自動で最後まで読む動作ではない
- 必要に応じて Ref を使った参照音声読み上げに切り替えられる
- 画面上に小さなペットが表示され、待機中と再生中で動きが変わる

## セットアップ

### 1. ダウンロード

```bat
git clone https://github.com/misaka310/chatgpt-local-voice-bridge.git
cd chatgpt-local-voice-bridge
```

zip で取得した場合も、展開したフォルダをそのまま使えます。

### 2. 初回セットアップ

```bat
setup-voice-env.cmd
```

必要な依存を入れて、ローカル音声環境を準備します。初回は CUDA 対応 PyTorch、Irodori direct 依存、Irodori モデル、codec を取得するため、時間がかかります。NVIDIA GPU / CUDA が使えない場合はここで止まります。

### 3. 音声 API を起動

```bat
run-voice-stack.cmd
```

起動後、次で確認できます。

```text
http://127.0.0.1:8717/health
```

`ok=true` なら起動完了です。

### 4. 拡張を読み込む

1. Chrome / Brave で `chrome://extensions` を開く
2. Developer mode を ON にする
3. Load unpacked を押す
4. このリポジトリの `extension/` を選ぶ
5. ChatGPT のタブを開き直す

## 使い方

1. ChatGPT を開く
2. 右上の Local Voice パネルを見る
3. Voice は `irodori-v3` のまま使う
4. Ref はまず `none` のまま使う
5. Auto を ON にする
6. そのあとに新しくメッセージを送る
7. 新しく出た assistant 返答の冒頭 preview だけが自動で再生される
8. `Next` は同じ返答の次 preview chunk を手動で読む

## ペット表示

- 画面右側に小さなペットが表示されます
- 待機中と再生中でアニメーションが切り替わります
- ローカルで自分用のペットに差し替えたい場合は [docs/pet.md](docs/pet.md) を見てください

## 読み上げの単位

- ChatGPT の assistant 返答を検知すると、冒頭 preview だけをローカル TTS API に送ります
- preview の上限は最大 2行 / 80文字 です
- Auto は返答全文を自動で最後まで読むものではありません
- Auto ON 前から画面にある返答は読みません
- Auto を OFF にしてから再度 ON にした場合も、その時点までの返答は読みません
- `Next` は Auto 用の自動全文読みではなく、同じ返答の preview chunk を手動で進めるボタンです

## 初期設定

- Voice: `irodori-v3`
- Ref: `none`
- 音量: 60%

まずは `Ref=none` のまま動作確認してください。

## 参照音声を使う

参照音声を使う場合は、次のようにファイルを置きます。

```text
local-api/reference/voices/sample/voice.wav
local-api/reference/voices/sample/text.txt
```

この場合、Options の Ref に `sample` を入れて使います。

- `voice.wav`: 参照したい音声
- `text.txt`: その音声で話している文字起こし

配置後に `run-voice-stack.cmd` を再起動し、拡張を reload して ChatGPT タブを開き直してください。

## よくある確認ポイント

### Auto ON だけで過去の返答を読み始める

これは不具合です。Auto ON 後に新しく出た assistant 返答だけを読むのが正しい動作です。

### `reference voice not found` と出る

まずは `Ref=none` に戻してください。参照音声を使う場合は、`voice.wav` と `text.txt` の配置を確認してください。

### 音が出ない

- `/health` で `ok=true` になるか確認する
- パネルが `Playing` まで進むか確認する
- `local-api/runtime/audio/` に wav が出ているか確認する
