# Windows GUI smoke testing

The normal CI workflow verifies source behavior with headless and offscreen tests. It does not prove that a user can open the packaged Windows tray menu or activate its controls.

`npm run test:gui:windows` adds a separate smoke test for the real `LocalVoiceBridge.exe` entrypoint. It uses Windows UI Automation selectors to locate the taskbar icon and Qt menu items. It does not use fixed screen coordinates.

## What it verifies

- the packaged launcher starts exactly one tray controller;
- the expected tray menu items exist and are enabled;
- the desktop pet is visible, responsive, and returns from a moved position through `Bring Desktop Pet Back`;
- a second launch does not create another controller;
- the Local Voice panel can be shown, remains responsive, and can be hidden;
- Restart dispatches and the tray remains operable;
- Exit removes the controller;
- the application can start and exit again after the first shutdown.

The menu contract also checks the presence of Logs, generated-audio, reference-voice, Windows-startup, and setup actions. Destructive setup execution and Windows startup registry changes are intentionally outside this first smoke test.

## Runner requirements

Use a dedicated Windows 11 VM or test machine. The runner must:

- run in a logged-in interactive desktop session;
- not run as a Windows service in Session 0;
- have the labels `self-hosted`, `windows`, `x64`, and `gui-automation`;
- have no controller from the same checkout already running;
- allow the test account to interact with the Windows taskbar.

Do not use the everyday desktop for this workflow because UI Automation opens the tray menu and panel during the test.

## Enabling pull-request runs

The workflow is safe to merge before the runner is ready. Pull-request GUI jobs stay skipped until the repository variable below is set:

```text
GUI_SELF_HOSTED_ENABLED=true
```

`workflow_dispatch` remains available for an explicit first run after the runner is registered.

## Output

Successful runs print one compact `PASS` line per scenario. A failure exits non-zero and stores the JSON result plus a desktop screenshot under:

```text
test-results/windows-gui-smoke/
```

GitHub Actions uploads that directory only when the job fails.
