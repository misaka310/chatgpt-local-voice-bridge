# ペット表示

このリポジトリでは、公開用のペット素材を最小限にしています。

## 公開リポに含めるもの

公開リリースに含めるのは、次の汎用プレースホルダーだけです。

```text
extension/assets/pet/pet.json
extension/assets/pet/placeholder.svg
```

個人用のペット素材は `extension/assets/pet/local/` に置きます。このフォルダは Git で無視されます。

`extension/assets/pet/local/voices/<voiceId>/` にペットを置くと、選択中の `Ref` が同じ `voiceId` のときに、そのペットへ切り替えられます。

## 読み込み順

拡張機能は、次の順番でペット設定を探します。

1. `extension/assets/pet/local/voices/<effectiveVoiceId>/pet.json`
2. `extension/assets/pet/local/voices/placeholder/pet.json`
3. `extension/assets/pet/local/pet.json`
4. `extension/assets/pet/pet.json`

選択中の Ref が `none` または空の場合、`effectiveVoiceId` は `placeholder` になります。

## 動き

- `idle`: 待機中
- `talking`: 再生中
- `happy`: 再生完了後
- `error`: エラー時

再生が終わると `happy` になり、その後 `idle` に戻ります。エラー時は `error` になり、その後 `idle` に戻ります。

## 配置と操作

- ペットは枠線、背景、ボーダーなしで表示されます。
- ペット位置はブラウザ保存領域の `petPosition` に保存されます。
- マウスでドラッグできます。
- ダブルクリックすると、既定の右下位置に戻ります。
- Local Voice パネルの位置は `panelPosition` に保存されます。

## ローカル差し替え

`extension/assets/pet/local.example/pet.json` を `extension/assets/pet/local/pet.json` にコピーし、placeholder の参照先を自分の spritesheet に差し替えてください。

`spritesheetPath` は、JSONファイルからの相対パスか、`assets/pet/...` から始まるパスで指定できます。

## 注意

公開リポジトリには、著作権や利用許諾が不明なキャラクター画像・配信者画像・個人用素材を入れないでください。

動きを変えたい場合は、`pet.json` の `animations` を編集します。
