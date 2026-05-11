# Codex 実装指示: ChatGPT Local Voice Bridge を push 可能な完成形にする

## 目的

Web版ChatGPTの返答をChrome拡張で検知し、冒頭だけをローカルTTS APIへ送り、生成音声をChatGPTページ上で再生できる状態にする。

今回の完成条件は「なんとなく動く」ではなく、以下を満たすこと。

- Windows 11 + Chrome + PowerShell でEnd-to-End確認できる
- 初期状態では `windows_sapi` または `mock_wav` で疎通確認できる
- Qwen3/ComfyUI連携へ切り替え可能
- 参照音源の置き場所と設定方法が明確
- 起動方法が明確
- Chrome拡張側からローカルAPIの状態確認と、可能なら起動ができる
- ChatGPT返答全文ではなく、冒頭3行相当だけを1回生成・再生する
- `.gitignore` とドキュメントが整理され、mainにpushしてよい状態になっている

## 固定方針

### 1. Playwright監視は本命にしない

ChatGPTページの検知はChrome拡張のcontent scriptで行う。
PlaywrightはE2Eテスト補助として使ってよいが、通常運用の監視手段にしない。

### 2. 参照音源はGitに入れない

参照音源は個人用・権利管理が必要なデータなので、実ファイルはGit管理外にする。
ただし、置き場所・ファイル名・設定例・README・`.gitkeep` はコミットする。

推奨配置:

```text
local-api/reference/
  README.md
  .gitkeep
  voice.wav          # Git管理外
  voice.txt          # Git管理外。参照音声の文字起こし
```

`.gitignore` で以下を除外する。

```gitignore
local-api/reference/*.wav
local-api/reference/*.mp3
local-api/reference/*.flac
local-api/reference/*.m4a
local-api/reference/*.ogg
local-api/reference/*.aac
local-api/reference/*.txt
!local-api/reference/README.md
!local-api/reference/.gitkeep
```

### 3. ローカル設定はGitに入れない

`local-api/config.example.json` をコミットし、実運用の `local-api/config.local.json` はGit管理外にする。
既存 `config.json` がある場合は、以下のどちらかに寄せる。

- 初期E2E用の安全な既定値として `config.json` をコミットする
- あるいは `config.example.json` のみコミットし、起動時に `config.local.json` がなければ自動生成する

推奨は後者。

### 4. Chrome拡張だけで任意exeを直接起動しようとしない

Chrome拡張単体ではローカルPowerShellやPythonプロセスを直接起動できない。
Chrome側から起動したい場合は、Native Messaging host を使う。

今回の完成形は2段階にする。

- 必須: 手動起動またはTask Scheduler起動でE2E確認できる
- 追加: Native Messaging host がインストール済みなら、拡張UIからStart/Stopできる

Native Messaging host は一度だけPowerShellスクリプトで登録する。

## 実装タスク

### A. 冒頭だけ読み上げる仕様へ変更

現在全文を読んでいる箇所を修正する。

実装する関数例:

```ts
extractSpeakPreview(fullText: string, options?: {
  maxChars?: number;
  maxLines?: number;
  minChars?: number;
}): string
```

仕様:

- 返答全文は送らない
- コードブロックは原則除外する
- 空行は無視する
- Markdown記号は必要最低限に正規化する
- 最大3行相当まで
- ハード上限は120文字程度
- 句点、疑問符、感嘆符で自然に切れるならそこで切る
- 最低40文字程度に満たない場合は、短すぎる生成を避けるため少し待つ
- ただし120文字に達したら即送る
- 1つのassistant応答につき自動送信は1回だけ
- 以後の本文追加は読まない

推奨値:

```ts
const SPEAK_PREVIEW = {
  maxLines: 3,
  maxChars: 120,
  minChars: 40,
  stableMs: 800,
};
```

自動送信条件:

- previewが `maxChars` 近くに達した
- またはpreviewが `minChars` 以上で、文末記号で終わっている
- またはpreviewが `minChars` 以上で、800ms程度テキストが安定した

絶対にやらないこと:

- 後続チャンクをキューに積まない
- 返答完了後に全文を再送しない
- 同じassistant応答を自動で複数回送らない

手動の「最新を読む」も同じく冒頭previewだけを読む。
全文読み上げボタンは今回不要。

### B. ローカルAPI設定を整理する

`local-api` 側に設定読み込み順を実装する。

優先順:

1. 環境変数
2. `local-api/config.local.json`
3. `local-api/config.json`
4. `local-api/config.example.json`
5. コード内デフォルト

必要な設定項目:

```json
{
  "host": "127.0.0.1",
  "port": 8765,
  "engine": "windows_sapi",
  "audioOutputDir": "./runtime/audio",
  "referenceAudioPath": "./reference/voice.wav",
  "referenceTextPath": "./reference/voice.txt",
  "comfyui": {
    "baseUrl": "http://127.0.0.1:8188",
    "workflowPath": "./workflows/qwen3_clone_api.json",
    "outputDir": "C:/ComfyUI/output",
    "timeoutSec": 300,
    "pollIntervalSec": 1.0
  }
}
```

`runtime/audio/` は生成物なのでGit管理外。

### C. 参照音源の置き場所をドキュメント化する

`local-api/reference/README.md` を作る。

内容:

- `voice.wav` に参照音声を置く
- `voice.txt` に参照音声の文字起こしを置く
- 実ファイルはGitに入れない
- Qwen3/ComfyUIモードではこの2つをworkflowへ反映する
- 既存ComfyUI workflowのLoadAudio/Qwen3VoiceClone参照文字起こしを使う場合は、configでパスを合わせる

### D. Qwen3/ComfyUIモードを実用化する

`engine = comfyui_qwen3` のとき、以下を行う。

- request bodyの `text` をQwen3VoiceCloneの生成本文に注入する
- 参照音声と参照文字起こしは設定から読む
- workflow内の該当ノードに反映できるなら反映する
- 既存workflowが固定参照音声を持つ場合は、configの参照パスが未指定でも動くようにする
- `/prompt` 投稿
- `/history/{prompt_id}` polling
- 出力音声ファイルを特定
- `/audio/<file>` でブラウザから取得できるURLを返す

既存の `32_dotitao-room/tools/batch_generate.py` 相当のロジックがあるなら、以下を再利用する。

- workflow JSON deep copy
- Qwen3VoiceClone.inputs.text 差し替え
- SaveAudio filename/output basename 差し替え
- ComfyUI `/prompt` POST
- `/history` 完了待ち
- audio/files/history outputから生成ファイル特定
- fallbackとしてoutputDir内のmtimeで最新音声を特定

### E. Chrome拡張UIの起動・状態確認を改善する

パネルに以下を追加する。

- API状態: 未起動 / 起動中 / 生成中 / 再生中 / エラー
- Health確認ボタン
- API URL表示
- Start APIボタン
- Stop APIボタン
- Native host未設定時の案内
- 現在の読み上げ対象が「冒頭のみ」であることの表示

Start/Stopの仕様:

1. まずNative Messaging hostが使えるか試す
2. 使える場合はhostに `start` / `stop` を送る
3. 使えない場合は、手動起動コマンドとREADMEへの導線を表示する

Chrome拡張単体でPowerShellを直接実行する実装は禁止。

### F. Native Messaging hostを追加する

任意だが、今回の要望ではできるだけ実装する。

配置案:

```text
tools/native-host/
  host.py
  manifest.template.json
scripts/
  install-native-host.ps1
  uninstall-native-host.ps1
```

hostの役割:

- Chrome拡張からNative MessagingでJSONを受け取る
- `status` でローカルAPIのhealthを確認
- `start` で `local-api` を起動
- `stop` で可能なら停止
- stdout/stdinのNative Messagingプロトコルを守る

Windows登録:

- `HKCU\Software\Google\Chrome\NativeMessagingHosts\<host_name>` にmanifestパスを書く
- install scriptは `-ExtensionId` を受け取り、allowed_originsに `chrome-extension://<id>/` を設定する

注意:

- Native host登録はユーザーが一度PowerShellで実行する必要がある
- unpacked拡張のIDが変わる場合は再登録が必要
- Native hostがない場合でも、手動起動でE2E成功すること

### G. 起動方法を整理する

`docs/startup.md` を作る。

必須記載:

#### 手動起動

```powershell
cd <repo-root>
.\scripts\start-local-api.ps1
```

#### 疎通確認

```powershell
.\scripts\smoke-local-api.ps1
```

#### Chrome拡張から起動する場合

1. Chrome拡張を読み込む
2. 拡張IDを確認
3. Native hostを登録
4. ChatGPTタブをリロード
5. パネルのStart APIを押す

#### Windows起動時に自動起動する場合

Task Schedulerを推奨。実装するなら `scripts/install-startup-task.ps1` と `scripts/uninstall-startup-task.ps1` を追加する。

### H. ドキュメント整理

最低限、以下を作成・更新する。

```text
README.md
CHANGELOG.md
docs/setup.md
docs/startup.md
docs/reference-audio.md
docs/qwen3-comfyui.md
docs/chrome-extension.md
docs/troubleshooting.md
docs/security.md
docs/repository-name.md
local-api/reference/README.md
```

READMEの最初に書くこと:

- これはWeb版ChatGPTの返答冒頭だけをローカルTTSで読むChrome拡張＋ローカルAPI
- 初期E2EはWindows標準音声で確認可能
- Qwen3/ComfyUIは設定で切り替える
- 参照音源はGitに入れない
- Chrome拡張から起動するにはNative Messaging hostが必要

### I. `.gitignore` を整える

最低限含める。

```gitignore
# dependencies
node_modules/
.venv/
__pycache__/
*.pyc

# build outputs
dist/
build/
*.zip

# local runtime
local-api/runtime/
local-api/.venv/
local-api/config.local.json
local-api/logs/

# generated audio
local-api/audio/
local-api/output/
public/audio/generated/

# private reference audio/text
local-api/reference/*.wav
local-api/reference/*.mp3
local-api/reference/*.flac
local-api/reference/*.m4a
local-api/reference/*.ogg
local-api/reference/*.aac
local-api/reference/*.txt
!local-api/reference/README.md
!local-api/reference/.gitkeep

# models / heavy assets
models/
*.safetensors
*.ckpt
*.pt
*.pth
*.onnx

# ChatGPT exports / private data
conversations.json
conversations-*.json
chat.html
exports/

# logs
*.log
```

### J. リポジトリ名

推奨名は以下。

```text
chatgpt-local-voice-bridge
```

理由:

- Qwen3固定ではなく、Windows SAPI/mock/Qwen3/ComfyUIを切り替えられる
- 用途が「ChatGPTのローカル音声ブリッジ」と分かる
- 将来Style-Bert-VITS2などに変えても名前が腐らない

代替:

```text
chatgpt-qwen3-readaloud-bridge
chatgpt-voice-preview-bridge
local-tts-chatgpt-reader
```

現在の目的なら `chatgpt-local-voice-bridge` を第一候補にする。

## 完了条件

### 機能

- [ ] `scripts/start-local-api.ps1` でローカルAPIが起動する
- [ ] `scripts/smoke-local-api.ps1` で音声生成と再生確認ができる
- [ ] Chrome拡張を読み込める
- [ ] ChatGPTページ右下にパネルが出る
- [ ] 「最新を読む」で冒頭previewだけが読まれる
- [ ] 自動ON時、新規assistant応答の冒頭previewだけが1回読まれる
- [ ] 同じ返答の全文や後続チャンクは読まれない
- [ ] サーバーログに `POST /v1/speak` と `GET /audio/...` が出る
- [ ] `engine=windows_sapi` または `mock_wav` でE2E成功する
- [ ] `engine=comfyui_qwen3` に切り替える手順がdocsにある

### 起動

- [ ] 手動起動手順がREADMEから辿れる
- [ ] Native Messaging hostが未導入でも詰まらない表示になっている
- [ ] Native Messaging host導入済みなら拡張からStart/Stopできる
- [ ] Task Scheduler運用を使う場合の手順がある

### Git管理

- [ ] 参照音源実ファイルがGitに入らない
- [ ] 生成音声がGitに入らない
- [ ] `config.local.json` がGitに入らない
- [ ] `config.example.json` はコミットされている
- [ ] `.gitignore` が整っている
- [ ] `git status` が意図しない生成物で汚れない

### ドキュメント

- [ ] READMEが最短セットアップから始まっている
- [ ] `docs/reference-audio.md` がある
- [ ] `docs/startup.md` がある
- [ ] `docs/qwen3-comfyui.md` がある
- [ ] `docs/troubleshooting.md` がある
- [ ] `docs/repository-name.md` がある

## 最終確認コマンド例

PowerShell前提。実際のscripts名に合わせて更新すること。

```powershell
cd <repo-root>
.\scripts\start-local-api.ps1
```

別PowerShell:

```powershell
cd <repo-root>
.\scripts\smoke-local-api.ps1
```

Chrome:

1. `chrome://extensions` を開く
2. extensionを読み込む
3. ChatGPTタブをリロード
4. 短い質問を送る
5. 右下パネルで状態確認
6. 冒頭だけ読み上げられることを確認

## 禁止事項

- 実参照音源をコミットしない
- 生成音声をmainに大量コミットしない
- ChatGPT返答全文を自動送信しない
- Native MessagingなしでChrome拡張からPowerShellを直接起動できるように見せかけない
- Playwright常駐監視を本命にしない
- 動作未確認のQwen3前提だけで完了扱いにしない
