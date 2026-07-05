# Architecture

This repository provides a Chrome / Brave extension that reads ChatGPT assistant replies through a local text-to-speech API.

The main design goal is local-first playback: ChatGPT text is detected in the browser, sent only to a localhost API, converted into audio, and played back in the active ChatGPT tab.

## Components

### Chrome extension

The extension is loaded from `extension/` as a Manifest V3 extension.

- `manifest.json` declares the content script, background service worker, storage permission, localhost host permissions, options page, icons, and pet assets.
- `content.js` runs on `https://chatgpt.com/*` and `https://chat.openai.com/*`.
- `background.js` owns queueing, TTS API calls, audio fetch validation, and playback coordination between tabs.
- `options.html` / `options.js` provide extension settings.

The extension intentionally limits host permissions to ChatGPT pages and the local API endpoints.

## Runtime flow

### 1. Tab registration

When a ChatGPT tab loads, `content.js` registers the tab with `background.js`.

`background.js` tracks known ChatGPT tabs, selects one UI owner, and broadcasts shared playback state back to content scripts.

Only the UI owner tab shows the floating Local Voice panel and pet UI.

### 2. Assistant reply detection

`content.js` observes the ChatGPT page with a `MutationObserver`.

It looks for assistant message nodes using ChatGPT-specific attributes first, then falls back to article-based detection.

Existing assistant messages are marked as already seen on startup and when Auto is enabled. This prevents the extension from replaying old replies when the user turns Auto on.

### 3. Text cleanup and chunking

Before playback, `content.js` removes elements that should not be spoken, including code blocks, buttons, menus, inputs, and scripts.

The text is normalized, markdown-like formatting is stripped from preview lines, and the result is split into preview chunks.

Current Auto behavior is intentionally conservative:

- Auto reads only the first preview chunk.
- Preview defaults to a maximum of 2 lines / 80 characters.
- `Next` manually advances to later preview chunks.
- `Regen` replays the current chunk.

This avoids turning long ChatGPT replies into unexpected full-length autoplay.

### 4. Queueing and TTS generation

`background.js` receives detected chunks from `content.js` and stores the latest assistant message for each tab.

When Auto, Next, Regen, or Replay requests playback, `background.js` enqueues one item and calls the local API:

```text
POST http://127.0.0.1:8717/v1/speak
```

The request includes the text, request id, source, voice profile, and reference voice id.

The local API returns an audio URL, usually under:

```text
http://127.0.0.1:8717/audio/...
```

### 5. Audio safety check

Before fetching audio, `background.js` validates the audio URL.

Allowed audio URLs must:

- use `127.0.0.1` or `localhost`
- match the configured local API port
- have a path starting with `/audio/`

This prevents the extension from fetching arbitrary remote audio URLs.

### 6. Browser playback

`background.js` asks the UI owner content script to play the audio.

`content.js` fetches the audio through `background.js`, converts it into a Blob URL, creates an `Audio` element, and reports completion or failure back to `background.js`.

`background.js` then updates queue state and broadcasts the next panel status.

## State ownership

`background.js` owns shared extension state:

- known ChatGPT tabs
- selected playback target
- UI owner tab
- playback queue
- current item
- last played item
- status text

`content.js` owns page-local state:

- DOM observation
- detected assistant message state
- floating panel DOM
- pet UI DOM
- current audio element
- local playback token

Chrome storage owns persisted user settings:

- Auto enabled state
- local API URL
- health URL
- voice profile
- reference voice id
- volume
- panel position / collapsed state
- pet position / pet selection

## Local API boundary

The extension assumes a local API with these endpoints:

```text
GET  /health
POST /v1/speak
GET  /audio/<file>
```

`/health` returns whether the API is ready.

`/v1/speak` generates audio and returns an `audioUrl`.

`/audio/<file>` serves the generated WAV file.

The extension does not require ChatGPT data to be sent to a remote server.

## Testing

The repository has Playwright E2E tests under `tests/e2e/`.

The tests load the unpacked extension into Chromium, serve a fake ChatGPT page, inject assistant message DOM, and verify that the panel reaches a successful playback state.

CI uses a lightweight localhost mock voice API instead of the real Irodori runtime. The mock API keeps the browser-extension path testable without downloading large model files.

## Current implementation note

`content.js` currently contains several responsibilities in one file: DOM detection, text cleanup, chunking, panel UI, pet UI, and playback.

This is intentionally left unchanged for now to avoid behavior drift. A future refactor should split these responsibilities only after the current E2E tests are stable enough to catch regressions.

## Known limitations

- ChatGPT DOM selectors may change.
- Auto mode intentionally reads only a preview, not the full response.
- Real voice quality is not verified in CI because CI uses a mock voice API.
- The local API must be running for real playback outside CI.
- The extension is intended for local personal use, not Chrome Web Store distribution in its current form.
