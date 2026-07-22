# Windows GUI smoke testing

The normal CI workflow verifies source behavior with headless and offscreen tests. It does not prove that a user can open the packaged Windows tray menu or activate its controls.

`npm run test:gui:windows` adds a separate smoke test for the real `LocalVoiceBridge.exe` entrypoint. It uses Windows UI Automation selectors to locate the taskbar icon and Qt menu items. It does not use fixed screen coordinates.

## What it verifies

- the packaged launcher starts exactly one tray controller;
- the expected tray menu items exist and are enabled;
- a second launch does not create another controller;
- the Local Voice panel can be shown, remains responsive, and can be hidden;
- Restart dispatches and the tray remains operable;
- Exit removes the controller;
- the application can start and exit again after the first shutdown.

The menu contract also checks the presence of Logs, generated-audio, reference-voice, Windows-startup, and setup actions. Destructive setup execution and Windows startup registry changes are intentionally outside this first smoke test.

## GitHub-hosted runner

This public repository runs the GUI smoke on GitHub-hosted `windows-latest`, so it does not require the 74 self-hosted VM and does not consume private-repository Actions minutes. The job runs for pull requests and remains available through `workflow_dispatch`.

The hosted runner provides a logged-in interactive Windows desktop. The smoke fails explicitly when the taskbar is unavailable, when another controller from the same checkout is already running, or when UI Automation cannot reach the tray menu or panel.

## Output

Successful runs print one compact `PASS` line per scenario. A failure exits non-zero and stores the JSON result plus a desktop screenshot under:

```text
test-results/windows-gui-smoke/
```

GitHub Actions uploads that directory only when the job fails.
