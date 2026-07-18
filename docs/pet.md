# ペット表示

ペットはWindowsデスクトップ上へ1体だけ表示します。Chrome / Brave内にはペット本体を表示しません。

## 役割と操作

デスクトップペットが行うのは表示と左ドラッグによる位置移動だけです。

- 左ドラッグ: デスクトップ上の位置を移動して保存
- 通常クリック: 何もしない
- ダブルクリック: 何もしない
- 右クリック: メニューを開かず、何もしない

Chrome、Local Voiceパネル、音声操作をペットから開く機能はありません。通知領域にもペット用の操作はありません。

## Refとの自動連動

ペットの種類はChrome / BraveのLocal Voiceパネルにある`Ref`と自動連動します。ペット専用の選択欄はありません。

- `Ref=misaka`なら`misaka`
- `Ref=asuka`なら`asuka`
- `Ref=none`または空なら`placeholder`
- 参照音声と同じIDの素材がない場合も`placeholder`へフォールバック

以前の`petMode`、`selectedPetId`、`petPosition`などのブラウザ設定が残っていても、起動時に安全に無視または削除されます。現在の選択状態を書き換えるのはChromeパネルの`Ref`だけです。

## 公開リポに含めるもの

公開リリースに含めるペット素材は、次の汎用プレースホルダーだけです。

```text
extension/assets/pet/pet.json
extension/assets/pet/placeholder.svg
```

個人用のペット素材は`extension/assets/pet/local/`へ置きます。このフォルダはGitで無視されます。著作権や利用許諾が不明な画像、配信者画像、個人用素材は公開リポジトリへ追加しないでください。

## 素材の配置

参照音声IDと連動させる素材は、次へ置きます。

```text
extension/assets/pet/local/voices/<refId>/pet.json
extension/assets/pet/local/voices/<refId>/spritesheet.png
```

共通のローカル素材は次へ置けます。

```text
extension/assets/pet/local/pet.json
extension/assets/pet/local/spritesheet.png
```

ひな形として`extension/assets/pet/local.example/pet.json`を利用できます。`spritesheetPath`は`pet.json`からの相対パスか、`assets/pet/...`から始まるパスで指定できます。対応画像形式はPNG、WebP、SVGです。透明部分はアルファチャンネルを保ったまま描画されます。

## 読み込み順

デスクトップペットは次の順で素材を探します。

1. `extension/assets/pet/local/voices/<refId>/pet.json`
2. `extension/assets/pet/local/voices/placeholder/pet.json`
3. `extension/assets/pet/local/pet.json`
4. `extension/assets/pet/pet.json`

選択中の素材が削除された、JSONが壊れている、画像が不足している場合は次の候補へフォールバックします。公開プレースホルダーまで読み込めない場合でも、Voice Bridge本体はペット素材の不足だけでは終了しません。

## `pet.json`

```json
{
  "id": "sample",
  "displayName": "Sample Pet",
  "spritesheetPath": "spritesheet.png",
  "columns": 6,
  "rows": 8,
  "frameWidth": 176,
  "frameHeight": 176,
  "displayScale": 0.5,
  "animations": {
    "idle": { "frames": [0, 5], "speed": 900 },
    "error": { "frames": [19], "speed": 900 }
  }
}
```

`displayScale`を省略した場合は既定の表示幅を使用します。`animations`がない場合やフレーム番号が不正な場合も、表示可能なフレームへ補正して停止画像として扱います。

## Windows上の実装

`ChatGPTLocalVoiceBridge.exe`から通知領域アプリを起動すると、透明なQtツールウィンドウとしてペットを1体表示します。タイトルバー、枠、四角い背景、影はありません。タスクバーやAlt+Tabへ通常アプリとして表示されないよう、Qtの`Tool`指定とWindowsのツールウィンドウ拡張スタイルを使用します。

位置と現在のペットIDは次へ保存されます。

```text
local-api/runtime/desktop-pet-settings.json
```

以前の設定で`visible=false`になっていても、現在の構成では起動時に表示へ戻します。Voice Bridgeが正常な場合は`idle`、起動失敗や異常時は`error`を表示します。
