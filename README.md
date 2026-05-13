# ChatGPT Local Voice Bridge

ChatGPT の応答をローカルTTSへ渡して再生する Chrome 拡張 + ローカルAPI のリポジトリです。

## ドキュメント

- 拡張機能の使い方: `docs/chrome-extension.md`
- セットアップ全体: `docs/setup.md`, `docs/startup.md`
- 運用とトラブル対応: `docs/operation.md`, `docs/troubleshooting.md`

## Pixel Pet（現在仕様）

- 拡張機能のペット表示は **Codexペット形式**（`pet.json` + `spritesheet.webp`）を使用します。
- 配置先は `extension/assets/pet/` です。
- 個別PNG（`idle_0.png` など）への分解は不要です。
- 個別PNGフォールバックは使いません（Codex形式のみを使用）。

詳細手順と確認ポイントは `docs/chrome-extension.md` を参照してください。
