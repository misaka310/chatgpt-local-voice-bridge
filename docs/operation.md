# 操作と検証

## 通常の使い方

1. `run-voice-stack.cmd` を起動する
2. Chrome / Brave に拡張機能を読み込む
3. ChatGPT を開く
4. Local Voice パネルで `Auto` を ON にする
5. Auto ON 後に新しく出た assistant 返答の preview が再生されることを確認する

## 既定値

- Model: `irodori-v3`
- Ref: `none`
- Runtime: `irodori_direct`

## 読み上げ範囲

Auto は返答全文を自動で最後まで読みません。

Auto で送るのは、assistant 返答の冒頭 preview だけです。上限は最大 2行 / 80文字です。

`Next` は、同じ返答から作られた次の preview chunk を手動で読むためのボタンです。

## 検証コマンド

```bat
npm run test:e2e:extension
npm run test:e2e:auto
npm run test:e2e:multichunk
```
