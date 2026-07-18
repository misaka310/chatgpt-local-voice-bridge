# 困ったとき

まずは `Ref=none` で確認してください。

通常起動では、通知領域の`ChatGPT Local Voice Bridge`を終了しないでください。変更後は、拡張機能をreloadしてChatGPTタブも開き直してください。

## 確認するもの

- `/health` が `ok=true` になるか
- パネルが `Playing` まで進むか
- `local-api/runtime/audio/` にwavが生成されるか

`/health` が失敗している、または音声ファイルがない場合、パネルの `Playing` 表示だけを成功と見なさず、先に API 起動を直してください。

## `reference voice not found` が出る

`Ref` を `none` に戻してください。

参照音声を使う場合は、`local-api/reference/voices/<voiceId>/` に `voice.wav` と `voice.txt` があるか確認してください。

## パネルが古い動きをする

拡張機能を reload して、ChatGPT タブを開き直してください。

## setup が止まる

次を確認してください。

- NVIDIA ドライバー
- CUDA対応Torch
- Hugging Face download cache の場所
- 空き容量
- ネットワーク接続

## ChatGPT の DOM 変更後に検知しない

ChatGPT の画面構造が変わると assistant 返答を検知できないことがあります。CI では実ChatGPT画面を使わず、固定fixtureだけを使います。まず拡張を reload し、ChatGPT タブを開き直してください。直らない場合は、DOM構造を前提にしたテストではなく、実際に assistant 返答が表示される画面で再現状況を記録してください。

## 通知領域アイコンやデスクトップペットが起動しない

`ChatGPTLocalVoiceBridge.exe`があるか確認し、なければ`setup-voice-env.cmd`をもう一度実行してください。通常起動にはランチャーEXEに加えて`python.exe`、`pythonw.exe`、`PySide6`、`QtWidgets`、`QtSvg`が必要です。

再セットアップ後も起動しない場合は、`local-api/logs/controller.log`を確認してください。

## Chrome内に古いペットが残る

拡張機能をreloadし、ChatGPTタブを開き直してください。現在の構成では、Chrome内にはペット本体を表示しません。

## デスクトップペットが画面外にある

通知領域の`ChatGPT Local Voice Bridge`を終了して再起動してください。モニター取り外しやDPI変更後に完全に画面外になった場合は、起動時に操作可能な位置へ一時補正されます。表示された位置からドラッグすると、新しい位置として保存されます。

## `Ref`を変えてもデスクトップペットが切り替わらない

`/health`が`ok=true`か確認し、拡張機能をreloadしてChatGPTタブを開き直してください。`Ref`はローカルAPIの`/v1/desktop-pet`を経由して同じIDのペットへ反映されます。`Ref=none`、空、または同じIDの素材がない場合は既定ペットが表示されます。通知領域アプリとAPIが起動していることも確認してください。

## ペット素材が表示されない

`pet.json`の`spritesheetPath`と画像形式を確認してください。デスクトップ側はPNG、WebP、SVGに対応します。選択中のローカル素材が利用できない場合は公開プレースホルダーへ戻ります。個人用素材は`extension/assets/pet/local/`へ置き、Gitへ追加しないでください。

## ローカルAPIを公開したい

対応していません。API は認証なしのローカル専用です。`host=0.0.0.0`、LAN IP、トンネル、`publicBaseUrl` の外部URLは設定できません。
