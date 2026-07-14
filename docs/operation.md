# 操作と検証

## 通常の使い方

1. `run-voice-stack.cmd`を起動し、`/health`の`ok=true`と`engine=irodori_direct`を確認します。
2. Chrome / Braveに`extension/`を読み込み、ChatGPTを開きます。
3. Local Voiceパネルで`Auto`をオンにしてから、新しいメッセージを送ります。
4. 新しい返答の冒頭プレビューが再生されることを確認します。

Autoは返答全文を自動再生しません。最大2行・80文字の先頭プレビューだけを一度送ります。`Next`は次のプレビューチャンク、`Replay`は直前の音声、`Regen`は現在のチャンクを再生成します。

## GPU不要のデモ

```bat
npm ci
npx playwright install chromium
npm run demo
```

Node.jsとChromiumだけで安全なローカルフィクスチャを開きます。Python、CUDA、GPU、モデル、ChatGPTログインは不要です。実際の拡張機能コードと`scripts/mock-voice-api.js`を使用します。Chromiumを閉じるか`Ctrl+C`を押すと、mock APIと一時ブラウザプロファイルを片付けます。

## mock CI

```bat
npm run test:ci
npm run demo:check
```

`test:ci`は次を終了コードで検証します。

- APIのhostと`publicBaseUrl`がloopbackだけを受け付けること
- Autoをオンにする前から表示されていた返答へ`POST /v1/speak`を送らないこと
- Auto後の新しい返答だけを対象にし、冒頭プレビューが80文字以内であること
- `POST /v1/speak`と`GET /audio/mock.wav`が成功すること
- `Next`が2チャンク目へ進むこと
- `Regen`が現在のチャンクを再生成すること
- `Replay`が再生成せず直前の音声を再取得すること
- 古い`qwen3`参照音声設定が`Ref=none`へ正規化されること
- UIが通信後に`Played chunk`へ到達すること

mockの成功は、実Irodoriの音質、GPU使用、実ChatGPTの将来のDOMを保証しません。

## 実機Irodoriの確認

```bat
npm run test:e2e:real
```

先に`setup-voice-env.cmd`を完了し、NVIDIA GPU、CUDA、モデルを用意してAPIを起動してください。実機では`/health`に加え、`local-api/runtime/audio/`へ作られた音声を実際に再生して確認します。
