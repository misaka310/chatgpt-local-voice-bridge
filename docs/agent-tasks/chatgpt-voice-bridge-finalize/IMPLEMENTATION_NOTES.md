# 実装メモ

## 冒頭3行相当の抽出

「画面上の3行」はウィンドウ幅で変わるため、そのまま使わない。
実装上は以下で近似する。

- 最大3つの非空テキスト行
- 最大120文字
- 句点・疑問符・感嘆符で自然に切れるならそこで切る
- コードブロックは除外

推奨ロジック:

1. Markdownコードブロックを除去
2. Markdown記号を軽く除去
3. 空行除去
4. 最大3行を連結
5. 120文字でハードカット
6. 可能なら最後の句点まで戻す
7. 40文字未満なら送信を少し待つ

## 自動送信の重複防止

assistant応答DOMごとにキーを持つ。

- DOM要素に `data-local-voice-sent="1"` を付ける
- またはWeakMapで送信済み管理
- テキスト内容hashを併用してもよい

自動送信後は、同じ返答が伸びても再送しない。

## ローカルAPI起動

Chrome拡張単体ではローカルプロセスを起動できない。
拡張から起動したい場合はNative Messaging hostが必要。

最低限の運用:

- ユーザーが `scripts/start-local-api.ps1` を実行
- あるいはTask Schedulerでログオン時に起動

追加運用:

- `scripts/install-native-host.ps1 -ExtensionId <id>`
- 拡張UIのStart APIボタンからNative hostへ `start`

## 参照音源

推奨配置:

```text
local-api/reference/voice.wav
local-api/reference/voice.txt
```

実ファイルはGit管理外。

Qwen3/ComfyUI workflowに固定で参照音源が入っている場合でも、ドキュメント上はこの配置を標準にする。
workflow側へ注入できるならconfigの参照パスを反映する。

## リポジトリ名

推奨: `chatgpt-local-voice-bridge`

Qwen3専用に見せないほうがよい。
今回の構成はローカルTTSブリッジであり、TTSエンジンは差し替え可能だから。
