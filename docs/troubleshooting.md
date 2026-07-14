# 困ったとき

まずは `Ref=none` で確認してください。

ローカルAPIのウィンドウは閉じずに開いたままにします。変更後は、拡張機能を reload して ChatGPT タブも開き直してください。

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

## ローカルAPIを公開したい

対応していません。API は認証なしのローカル専用です。`host=0.0.0.0`、LAN IP、トンネル、`publicBaseUrl` の外部URLは設定できません。
