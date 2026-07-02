# セットアップ

公開導線は Irodori direct / irodori-v3 / Ref=none です。

## 実行

リポジトリルートで `setup-voice-env.cmd` を実行します。

このbatは次を行います。

1. `local-api/.venv` 作成
2. pip更新
3. CUDA対応Torch導入
4. Irodori direct依存導入
5. CUDA/Torch確認
6. Irodoriモデルとcodecを Hugging Face cache へ事前取得
7. `local-api/runtime/audio` 作成

setup完了表示は、モデルとcodecの取得確認後にだけ出ます。

## キャッシュ

通常は `%USERPROFILE%\.cache\huggingface` です。`HF_HOME` を指定している場合はその場所です。

## CPUで試す場合

公開初回UXでは NVIDIA GPU を前提にします。CUDAが使えない場合、setupは止まります。CPUで試す場合は `local-api/config.local.json` で `irodori.requireCuda=false` にできますが、かなり遅くなります。
