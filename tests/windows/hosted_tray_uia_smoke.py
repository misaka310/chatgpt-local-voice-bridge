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

    def original_controller_only():
        pids = [process.pid for process in smoke.controller_processes()]
        return pids if pids == [original_pid] else None

    smoke.wait_until(
        "duplicate controller to exit",
        original_controller_only,
        timeout=10,
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
