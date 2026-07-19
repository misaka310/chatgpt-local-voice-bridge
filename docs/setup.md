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
8. 通常起動用の小さな`ChatGPTLocalVoiceBridge.exe`を生成
9. Windowsのスタートメニューへ`ChatGPT Local Voice Bridge`を登録

setup完了表示は、モデルとcodecの取得確認、ランチャーEXEの生成、スタートメニュー登録が終わった後にだけ出ます。登録後はWindows検索から`ChatGPT Local Voice Bridge`を起動できます。

## キャッシュ

通常は `%USERPROFILE%\.cache\huggingface` です。`HF_HOME` を指定している場合はその場所です。

## CUDA を使えない場合

公開初回導線は NVIDIA GPU/CUDA を前提にしています。CUDA が使えない場合、setup は止まります。CPU 実行へ設定を書き換える方法は通常利用としてサポートしていません。GPU要件を満たせない場合でも、拡張の通信確認だけなら `npm run test:ci` を利用できます。
