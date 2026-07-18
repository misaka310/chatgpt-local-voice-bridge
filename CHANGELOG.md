# Changelog

## Unreleased

- Pinned `transformers` to the security-fixed 5.5.0 release, pinned `huggingface-hub` to the verified 1.23.0 release, and pinned the verified Irodori source commit.
- Made Irodori v3 direct the supported local TTS path while preserving the preview-only Auto UX.
- Kept Auto from reading replies that were already visible before it was enabled.
- Preserved the `Next`, `Regen`, and `Replay` controls and added mock E2E coverage for their network behavior.
- Added a GPU-free Chromium demo that uses the real extension code and a shared mock voice API.
- Added loopback-only API enforcement, automated boundary tests, and `SECURITY.md`.
- Added a concise public README, an explicit environment matrix, limitations, and a lightweight visual demo.
- Added a reproducible public-tree check for private files, generated files, broken documentation links, and media limits.
- Fixed repeated FFmpeg path registration and synchronized the PowerShell startup and smoke scripts with Irodori v3.
- Replaced the normal VBS startup path with a small Windows launcher EXE while keeping the old VBS file only as a compatibility forwarder.
- Consolidated daily operation into the Chrome / Brave Local Voice panel and removed the redundant Voice, Tab, and Pet fields.
- Linked the desktop pet directly to Ref, including safe migration of legacy browser pet settings and placeholder fallback.
- Removed the in-page Chrome pet implementation and limited the single Windows desktop pet to display and left-drag movement.
- Reduced the tray to service management and added regression coverage for panel collapse, active-tab ownership, pet interactions, launcher self-test, and loopback-only operation.
