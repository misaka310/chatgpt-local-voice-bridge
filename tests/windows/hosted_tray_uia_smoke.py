from __future__ import annotations

import subprocess

from pywinauto import Desktop

import tray_uia_smoke as smoke


def find_qt_popup(_pid: int) -> smoke.WindowInfo | None:
    desktop = Desktop(backend="uia")
    for row in smoke.enum_top_windows():
        if not smoke.USER32.IsWindowVisible(row.hwnd):
            continue
        try:
            wrapper = desktop.window(handle=row.hwnd)
            names = {
                item.window_text().strip()
                for item in wrapper.descendants(control_type="MenuItem")
            }
        except Exception:
            continue
        if "Exit" in names and "Restart Voice Bridge" in names:
            return row
    return None


def panel_window(_pid: int) -> smoke.WindowInfo | None:
    return next(
        (
            row
            for row in smoke.enum_top_windows()
            if row.title == smoke.APP_NAME
            and "QWindowPopup" not in row.class_name
            and row.class_name != "#32770"
            and smoke.USER32.IsWindowVisible(row.hwnd)
        ),
        None,
    )


def pet_window(_pid: int) -> smoke.WindowInfo | None:
    return next(
        (
            row
            for row in smoke.enum_top_windows()
            if row.title == smoke.PET_WINDOW_TITLE
            and smoke.USER32.IsWindowVisible(row.hwnd)
        ),
        None,
    )


def assert_single_instance(original_pid: int) -> None:
    completed = subprocess.run([str(smoke.EXE)], cwd=smoke.ROOT, timeout=15, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"second launcher returned {completed.returncode}")

    def duplicate_dialog_windows():
        rows = [
            row
            for row in smoke.enum_top_windows()
            if row.title == smoke.APP_NAME
            and row.class_name == "#32770"
            and smoke.USER32.IsWindowVisible(row.hwnd)
        ]
        return rows or None

    dialogs = smoke.wait_until(
        "duplicate-instance information dialog",
        duplicate_dialog_windows,
        timeout=10,
    )
    desktop = Desktop(backend="uia")
    for row in dialogs:
        dialog = desktop.window(handle=row.hwnd)
        ok_button = dialog.child_window(title="OK", control_type="Button")
        if not ok_button.exists(timeout=2):
            raise AssertionError("duplicate-instance dialog has no OK button")
        ok_button.click_input()

    smoke.wait_until(
        "duplicate-instance dialog to close",
        lambda: not duplicate_dialog_windows(),
        timeout=5,
    )
    smoke.assert_menu_contract(original_pid)


def main() -> int:
    smoke.find_qt_popup = find_qt_popup
    smoke.panel_window = panel_window
    smoke.pet_window = pet_window
    smoke.assert_single_instance = assert_single_instance
    return smoke.main()


if __name__ == "__main__":
    raise SystemExit(main())
