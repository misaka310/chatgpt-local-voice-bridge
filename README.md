# ChatGPT Local Voice Bridge

ChatGPTの新しい返答を検出し、その冒頭をPC内で音声に変換して自動で読み上げるChrome / Brave拡張です。

https://github.com/user-attachments/assets/55580bbe-1325-4548-a03b-d70f7004a7fb

再生ボタンから、ChatGPTの新しい返答を自動で読み上げる流れを映像と音声で確認できます。

映像は実ChatGPTアカウントではなく、安全なローカルフィクスチャで実際の拡張機能コードを動かしています。ローカル音声生成エンジンにはIrodori v3を使用しています。

## 主な機能

- Autoをオンにした後の新しい返答だけを検出し、最大2行・80文字の冒頭を一度だけ再生
- Autoをオンにする前から表示されていた返答は読み上げない
- `Next`で続き、`Replay`で聞き直し、`Regen`で現在の部分を再生成
- API・生成音声・任意の参照音声を同じPC内で管理
- 実モデル不要のデモとCIで、拡張機能の通信・再生境界を確認可能
- Windowsの通知領域に常駐し、通常利用ではターミナルを開かない
- 日常操作はChrome / BraveのLocal Voiceパネルへ集約し、デスクトップペットは表示と左ドラッグ移動だけを担当

## GPU不要の2分デモ

```bat
npm ci
npx playwright install chromium
npm run demo
```

Node.js 22とChromiumだけで起動します。Python、CUDA、GPU、Hugging Faceモデル、ChatGPTへのログインは不要です。表示される画面は「ローカルデモフィクスチャ」であり、実ChatGPT画面ではありません。終了時はChromiumを閉じるか`Ctrl+C`を押してください。

終了コードで検証する場合：

```bat
npm run demo:check
```

## Setup / 初回セットアップ

初回だけ次を実行します。

```bat
setup-voice-env.cmd
```

## Usage / 起動と操作

セットアップ後は`ChatGPTLocalVoiceBridge.exe`をダブルクリックします。EXEは既存のPython環境をターミナルなしで起動するだけです。日常の音声操作はChrome / BraveのLocal Voiceパネルで行います。通知領域は状態確認、再起動、フォルダ表示、自動起動、再セットアップ、終了だけを担当します。デスクトップペットは`Ref`と自動連動して1体だけ表示され、左ドラッグで移動できます。クリック、ダブルクリック、右クリックでは何も起きません。

`http://127.0.0.1:8717/health`を開き、`ok=true`と`engine=irodori_direct`を確認します。その後、Chrome / Braveの拡張機能画面でDeveloper modeを有効にし、**Load unpacked**から`extension/`を選択してください。

最初は`Ref=none`のまま、Local VoiceパネルでAutoをオンにしてから新しいメッセージを送ります。新しい返答の先頭プレビューが再生されれば完了です。参照音声の追加方法は[参照音声](docs/reference-audio.md)を参照してください。

ターミナルでサーバーログを直接確認したい場合だけ、診断用の`run-voice-stack.cmd`を使用します。

## Requirements / 対応環境

| モード | 必須 | 検証済み | 未対応・未検証 |
| --- | --- | --- | --- |
| 軽量デモ / mock CI | Node.js 22、Chromium | Windows 11のPlaywright Chromium | Firefox、macOSの実行は未検証 |
| 実音声 | Windows、Python、NVIDIA GPU、CUDA、Irodori v3 | Windows 11、Playwright Chromium、NVIDIA CUDA環境 | Chrome / Braveの手動確認、CPUのみ、macOS、Linux、Firefox、Edgeは未検証または未対応 |

GPU、VRAM、ブラウザごとの扱いは[動作環境](docs/hardware.md)にまとめています。未検証の環境を対応済みとはしていません。

## Verification / 動作確認

開発環境では次を実行します。

```bat
npm run test:python
npm run test:background
npm run test:e2e:mock
npm run check:public
```

通常起動の確認は、通知領域の状態と`http://127.0.0.1:8717/health`の`ok=true`を使用します。デスクトップペットのWindows実画面確認手順は[起動とヘルス確認](docs/startup.md)にあります。

## Limitations / 制約

- ChatGPTのDOM変更により、返答検出が一時的に動作しなくなる可能性があります。
- CIはChatGPTに似た固定フィクスチャを使い、将来の実ChatGPT DOMを保証しません。
- 軽量デモは統合動作の確認用で、Irodoriの音声品質評価ではありません。
- 実モデルE2EにはWindows、NVIDIA GPU、CUDA、モデル取得が必要です。
- ローカルAPIには認証がないため、LAN、インターネット、トンネルへ公開できません。

## 詳細ドキュメント

- [初回セットアップ](docs/setup.md)
- [起動とヘルス確認](docs/startup.md)
- [操作とテスト](docs/operation.md)
- [動作環境](docs/hardware.md)
- [困ったとき](docs/troubleshooting.md)
- [参照音声](docs/reference-audio.md)
- [セキュリティ境界](SECURITY.md)
- [構成](ARCHITECTURE.md)
