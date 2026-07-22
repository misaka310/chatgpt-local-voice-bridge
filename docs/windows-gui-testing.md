# Windows GUI smoke testing

The normal CI workflow verifies source behavior with headless and offscreen tests. It does not prove that a user can open the packaged Windows tray menu or activate its controls.

`npm run test:gui:windows` is the target-side test contract for the real `LocalVoiceBridge.exe` entrypoint. It uses Windows UI Automation selectors to locate the taskbar icon and Qt menu items. It does not use fixed screen coordinates.

## What it verifies

- the packaged launcher starts exactly one tray controller;
- the expected tray menu items exist and are enabled;
- the desktop pet is visible, responsive, and returns from a moved position through `Bring Desktop Pet Back`;
- a second launch does not create another controller;
- the Local Voice panel can be shown, remains responsive, and can be hidden;
- Restart dispatches and the tray remains operable;
- Exit removes the controller;
- the application can start and exit again after the first shutdown.

The menu contract also checks the presence of Logs, generated-audio, reference-voice, Windows-startup, and setup actions. Destructive setup execution and Windows startup registry changes are intentionally outside this smoke test.

## Central runner

The dedicated GUI runner is owned by `misaka310/windows-gui-ci-runner`, not by this repository. Its repository-scoped runners must not be referenced directly from a workflow in `local-voice-bridge`.

The central workflow allowlists this target as `17-local-voice-bridge` and checks out the exact requested branch, tag, or commit SHA. Run `Central Windows GUI test` in the central repository with:

```text
target_id: 17-local-voice-bridge
target_ref: <exact local-voice-bridge commit SHA>
```

That workflow performs the complete lifecycle: restore the clean VM snapshot, start the VM, require an interactive guest heartbeat, execute `scripts/run-windows-gui-smoke.ps1`, upload evidence, stop the VM, and restore the clean snapshot again.

## Runner requirements

The central infrastructure must provide:

- a dedicated Windows 11 VM or test machine;
- a logged-in interactive desktop session;
- a guest runner that is not installed as a Session 0 Windows service;
- the labels `self-hosted`, `windows`, `x64`, and `gui-vm`;
- no controller from the checked-out target already running;
- permission for the test account to interact with the Windows taskbar.

Do not run this test on the everyday desktop because UI Automation opens the tray menu and panel during the test.

## Output

Successful runs print one compact `PASS` line per scenario. A failure exits non-zero and stores the JSON result plus a desktop screenshot under:

```text
test-results/windows-gui-smoke/
```

The central workflow copies that directory into its evidence artifact together with the target repository, ref, machine, session ID, and timestamp.
