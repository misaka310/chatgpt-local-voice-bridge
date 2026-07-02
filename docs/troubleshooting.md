# 困ったとき

まずは `Ref=none` で確認してください。

ローカルAPIのウィンドウは閉じずに開いたままにします。変更後は、拡張機能を reload して ChatGPT タブも開き直してください。

## 確認するもの

- `/health` が `ok=true` になるか
- パネルが `Playing` まで進むか
- `local-api/runtime/audio/` にwavが生成されるか

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
