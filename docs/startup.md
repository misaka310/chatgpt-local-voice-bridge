# 起動

`run-voice-stack.cmd` を起動します。

## 表示される内容

- Local API URL
- Health URL
- Python path
- runtime: `irodori_direct`
- model: `irodori-v3`
- cache確認結果

最初の `/v1/speak` は、モデルをGPUメモリへ読み込むため時間がかかります。

## 成功条件

`/health` で次の状態になれば起動できています。

- `ok=true`
- `runtime=irodori_direct`
- `defaultModel=irodori-v3`

smoke確認では、`/v1/speak` に `model=irodori-v3` と `referenceVoice=""` をPOSTします。

成功後、`local-api/runtime/audio` にwavが生成されます。
