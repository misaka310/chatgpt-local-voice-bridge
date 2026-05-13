# Chrome拡張

## 役割

- ChatGPT の assistant 応答を監視し、ローカルAPI（`/v1/speak`）へ送信します。
- 生成された音声を拡張UIから再生します。
- 画面上に Pixel Pet を表示し、`idle / talking / thinking / happy / error` の状態を切り替えます。

## Pixel Pet の現在仕様（Codex形式）

- 使用形式は **`pet.json` + `spritesheet.webp`** です。
- 配置先は `extension/assets/pet/` です。
- 個別PNG（`idle_0.png` など）への分解は不要です。
- 個別PNGフォールバックは廃止し、Codex形式を常に使用します。
- 拡張は `pet.json` を読み、`spritesheet.webp` の1フレームだけを `background-position` で切り出して表示します。
- スプライトシート全体を `<img>` で直接表示する方式は使いません。

### 必須ファイル

- `extension/assets/pet/pet.json`
- `extension/assets/pet/spritesheet.webp`

### `pet.json` の最小例

```json
{
  "id": "my-pet",
  "spritesheetPath": "spritesheet.webp"
}
```

補足:
- `columns`, `rows`, `frameWidth`, `frameHeight`, `animations` は省略可能です。
- 省略時は拡張側の既定値を使います。

## 拡張の再読み込み手順

1. `chrome://extensions` を開く
2. 対象拡張（ChatGPT Local Voice Bridge）を探す
3. `再読み込み` を押す
4. ChatGPT タブをリロードする

## アイコン

- `manifest.json` の `icons` は `extension/assets/icons/` を参照します。
- 参照ファイル:
  - `icon16.png`
  - `icon32.png`
  - `icon48.png`
  - `icon128.png`

## トラブルシュート

### スプライトシート全体が表示される

- `content.js` の `applyPetSpriteFrame` が実行されているか確認してください。
- `#local-voice-pixel-pet` の子要素で、`background-size` と `background-position` が設定されているか確認してください。
- `pet.json` の `columns` / `rows` が実際のシート構成とずれていないか確認してください。

### 1フレームだけ表示されない

- `frameWidth` / `frameHeight` の解釈がずれている可能性があります。
- まずは `pet.json` の `frameWidth` / `frameHeight` を明示し、意図した1フレーム寸法になるか確認してください。
- 既定値利用時は、シート寸法と列行数から自動計算されるため、`columns` / `rows` の誤りがあると崩れます。

### WebP が読めない

- `extension/assets/pet/spritesheet.webp` が存在するか確認してください。
- `manifest.json` の `web_accessible_resources` に `assets/pet/spritesheet.webp` が含まれているか確認してください。
- DevTools コンソールに `Failed to load Codex pet assets` が出ていないか確認してください。

### `pet.json` の形式が合わない

- JSON構文エラー（カンマ抜け、余分なコメントなど）がないか確認してください。
- `spritesheetPath` が未設定だと読み込みできません。
- `animations` を指定する場合、`frames` は数値配列にしてください。
