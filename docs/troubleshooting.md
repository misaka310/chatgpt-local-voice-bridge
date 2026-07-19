# 困ったとき

まずはWindows Local Voice小窓で`Ref=none`にして確認してください。

通常起動では、通知領域の`Local Voice Bridge`を終了しないでください。変更後は、`chrome://extensions`で拡張機能をreloadし、開いているChatGPTタブも再読み込みしてください。

## 確認するもの

- `/health`が`ok=true`になるか
- Windows Local Voice小窓が`Waiting for ChatGPT`から`Ready`へ進むか
- 読み上げ時に小窓が`Generating`、`Playing`へ進むか
- `local-api/runtime/audio/`にwavが生成されるか

`/health`が失敗している、または音声ファイルがない場合、小窓の表示だけを成功と見なさず、先にAPI起動を直してください。

## Windows Local Voice小窓が開かない

次を順番に確認してください。

1. 通知領域に`Local Voice Bridge`がある
2. 通知領域の`Show Local Voice panel`を選ぶ
3. ペットを移動せずに左ダブルクリックする
4. `local-api/logs/controller.log`を確認する

ドラッグ直後のダブルクリックは誤操作防止のため無効です。少し待ってから、移動させずにダブルクリックしてください。

## 小窓が`Waiting for ChatGPT`のまま

ローカルAPIは起動していますが、更新後の拡張機能が接続していません。

1. `chrome://extensions`で`Local Voice Bridge`をreloadする
2. 開いているChatGPTタブをすべて再読み込みする
3. ChatGPTタブが小窓の`tabs`表示へ数えられることを確認する

Chrome内にLocal Voice操作パネルが出ないのは正常です。

## Chrome内に古いLocal Voiceパネルが残る

拡張機能をreloadし、ChatGPTタブを再読み込みしてください。現在の構成では、Chrome内に操作パネルを生成しません。旧`panelPosition`と`panelCollapsed`設定も設定バージョン9への移行時に削除されます。

## 全ChatGPTタブの返答を読まない

Autoは最後に触った1タブだけではなく、開いているすべてのChatGPTタブを対象にします。

- 小窓の`tabs`数が開いているChatGPTタブ数と一致するか確認する
- 対象タブを更新後の拡張機能で再読み込みする
- Autoを一度オフにしてからオンにし、その後に新しい返答を生成する

Autoをオンにする前から表示されていた返答は読みません。`思考中`、`考え中`、`Thinking`、`画像を分析しています`だけの途中状態も読みません。

## `reference voice not found`が出る

小窓の`Ref`を`none`へ戻してください。

参照音声を使う場合は、`local-api/reference/voices/<voiceId>/`に`voice.wav`と`voice.txt`があるか確認してください。

## `Ref`を変えてもデスクトップペットが切り替わらない

`/health`が`ok=true`か確認してください。小窓の`Ref`はローカルAPIの`/v1/control-panel/settings`から拡張機能へ同期され、拡張機能が`/v1/desktop-pet`へ同じIDを送ります。

- 拡張機能をreloadする
- ChatGPTタブを再読み込みする
- 小窓が`Waiting for ChatGPT`ではなく`Ready`になることを確認する

`Ref=none`、空、または同じIDの素材がない場合は既定ペットが表示されます。

## マイク会話中にYouTubeが停止しない

この連携には、入力元ごとの状態を扱う対応版YouTube Dictation Pause Controlが必要です。

1. `http://127.0.0.1:17654/health`が`ok=true`を返すことを確認する
2. YouTube Dictation Pause Controlの`logs/control.log`に`source=local-voice-bridge active=true`が記録されるか確認する
3. 記録がなければ、両アプリが今回の連携対応ブランチで起動しているか確認する
4. ポートを変更している場合は、`YOUTUBE_DICTATION_PAUSE_STATE_URL`を実際の`/state` URLへ設定する

通知先が不在でもLocal Voice Bridgeの録音は継続します。そのため、録音できることだけではYouTube連携の成功確認になりません。

## setupが止まる

次を確認してください。

- NVIDIAドライバー
- CUDA対応Torch
- Hugging Face download cacheの場所
- 空き容量
- ネットワーク接続

## ChatGPTのDOM変更後に検知しない

ChatGPTの画面構造が変わるとassistant返答を検知できないことがあります。CIでは実ChatGPT画面を使わず、固定fixtureだけを使います。まず拡張機能をreloadし、ChatGPTタブを再読み込みしてください。直らない場合は、実際にassistant返答が表示される画面で再現状況を記録してください。

## 通知領域アイコンやデスクトップペットが起動しない

`LocalVoiceBridge.exe`があるか確認し、なければ`setup-voice-env.cmd`をもう一度実行してください。通常起動にはランチャーEXEに加えて`python.exe`、`pythonw.exe`、`PySide6`、`QtWidgets`、`QtSvg`が必要です。

再セットアップ後も起動しない場合は、`local-api/logs/controller.log`を確認してください。

## Chrome内に古いペットが残る

拡張機能をreloadし、ChatGPTタブを再読み込みしてください。現在の構成では、Chrome内にはペット本体を表示しません。

## デスクトップペットが画面外にある

通知領域の`Local Voice Bridge`を終了して再起動してください。モニター取り外しやDPI変更後に完全に画面外になった場合は、起動時に操作可能な位置へ一時補正されます。表示された位置からドラッグすると、新しい位置として保存されます。

## ペット素材が表示されない

`pet.json`の`spritesheetPath`と画像形式を確認してください。デスクトップ側はPNG、WebP、SVGに対応します。選択中のローカル素材が利用できない場合は公開プレースホルダーへ戻ります。個人用素材は`extension/assets/pet/local/`へ置き、Gitへ追加しないでください。

## ローカルAPIを公開したい

対応していません。APIは認証なしのローカル専用です。`host=0.0.0.0`、LAN IP、トンネル、`publicBaseUrl`の外部URLは設定できません。
