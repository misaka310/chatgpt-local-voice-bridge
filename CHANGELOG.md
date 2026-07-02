# Changelog

## Unreleased

- Simplified the Chrome panel controls to `Auto`, `Next`, `Regen`, and `Replay`.
- Fixed manual `Next` so the first press reads chunk `1/N` instead of skipping ahead.
- Added `Regen`/`Replay` distinction in docs and status text.
- Made Qwen direct TTS the public default path.
- Treated Irodori v3 via ComfyUI as an optional advanced path requiring local workflow files.
- Clarified that `Prompt` is used for Qwen direct TTS and is not wired into the current Irodori workflow path.
- Strengthened ignore rules for local reference voices, generated audio, runtime debug files, local workflows, and local pet assets.
- Removed old agent task handoff documents from the public-ready tree.
