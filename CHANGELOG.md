# Changelog

## Unreleased

- Made Irodori v3 direct the supported local TTS path while preserving the preview-only Auto UX.
- Kept Auto from reading replies that were already visible before it was enabled.
- Preserved the `Next`, `Regen`, and `Replay` controls and added mock E2E coverage for their network behavior.
- Added a GPU-free Chromium demo that uses the real extension code and a shared mock voice API.
- Added loopback-only API enforcement, automated boundary tests, and `SECURITY.md`.
- Added a concise public README, an explicit environment matrix, limitations, and a lightweight visual demo.
- Added a reproducible public-tree check for private files, generated files, broken documentation links, and media limits.
- Fixed repeated FFmpeg path registration and synchronized the PowerShell startup and smoke scripts with Irodori v3.
