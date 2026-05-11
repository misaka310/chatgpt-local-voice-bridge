# セットアップ

## 前提

- Windows 11
- Python 3.10+
- Google Chrome
- Web版ChatGPTにログイン済み

## 1. API起動

```powershell
.\scripts\start-local-api.ps1
```

## 2. API疎通

```powershell
.\scripts\smoke-local-api.ps1
```

`/v1/speak` と `/audio/...` が通り、音声が再生されればOKです。

## 3. Chrome拡張を読み込み

1. `chrome://extensions` を開く
2. デベロッパーモードON
3. 「パッケージ化されていない拡張機能を読み込む」
4. `extension/` フォルダを選択

## 4. ChatGPTで確認

- `https://chatgpt.com/` を開く
- 右下 `Local Voice` パネルが表示される
- 自動ONで、新規assistant返答の冒頭previewだけが1回読まれる

## 補足

- 詳細手順: [docs/startup.md](startup.md)
- Qwen3切替: [docs/qwen3-comfyui.md](qwen3-comfyui.md)
