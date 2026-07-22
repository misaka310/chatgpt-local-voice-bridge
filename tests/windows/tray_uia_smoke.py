from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import time
import traceback
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Iterable

import psutil
from PIL import ImageGrab
from pywinauto import Desktop

APP_NAME = "Local Voice Bridge"
PET_WINDOW_TITLE = "Local Voice Bridge Desktop Pet"
ROOT = Path(__file__).resolve().parents[2]
EXE = ROOT / "LocalVoiceBridge.exe"
CONTROLLER = (ROOT / "local-api" / "tray_controller.py").resolve()
CONTROLLER_LOG = ROOT / "local-api" / "logs" / "controller.log"
RESULT_DIR = Path(os.environ.get("GUI_SMOKE_RESULT_DIR", ROOT / "test-results" / "windows-gui-smoke"))
RESULT_JSON = RESULT_DIR / "result.json"
FAILURE_SCREENSHOT = RESULT_DIR / "failure.png"
EXPECTED_ACTIONS = (
    "Show Local Voice panel",
    "Bring Desktop Pet Back",
    "Restart Voice Bridge",
    "Open controller log",
    "Open generated audio folder",
    "Open reference voices folder",
    "Start with Windows",
    "Exit and run environment setup",
    "Exit",
)

USER32 = ctypes.windll.user32
WM_CLOSE = 0x0010
WM_NULL = 0x0000
SMTO_ABORTIFHUNG = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010


@dataclass(frozen=True)
class WindowInfo:
    hwnd: int
    pid: int
    title: str
    class_name: str


@dataclass
class ScenarioResult:
    name: str
    passed: bool
    detail: str = ""


def wait_until(description: str, predicate: Callable[[], object], timeout: float = 10.0, interval: float = 0.2):
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except Exception as exc:
            last_error = exc
        time.sleep(interval)
    suffix = f"; last error: {last_error}" if last_error else ""
    raise TimeoutError(f"Timed out waiting for {description}{suffix}")


def enum_top_windows() -> list[WindowInfo]:
    rows: list[WindowInfo] = []
    enum_proc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

    def callback(hwnd: int, _lparam: int) -> bool:
        title_length = USER32.GetWindowTextLengthW(hwnd)
        title_buffer = ctypes.create_unicode_buffer(title_length + 1)
        USER32.GetWindowTextW(hwnd, title_buffer, len(title_buffer))
        class_buffer = ctypes.create_unicode_buffer(256)
        USER32.GetClassNameW(hwnd, class_buffer, len(class_buffer))
        pid = wt.DWORD()
        USER32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        rows.append(WindowInfo(int(hwnd), int(pid.value), title_buffer.value, class_buffer.value))
        return True

    USER32.EnumWindows(enum_proc(callback), 0)
    return rows


def controller_processes() -> list[psutil.Process]:
    marker = os.path.normcase(str(CONTROLLER))
    rows: list[psutil.Process] = []
    for process in psutil.process_iter(["pid", "cmdline", "create_time"]):
        try:
            arguments = [os.path.normcase(os.path.abspath(value)) for value in (process.info.get("cmdline") or [])]
            if marker in arguments:
                rows.append(process)
        except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
            continue
    return sorted(rows, key=lambda item: item.pid)


def launch_app() -> psutil.Process:
    completed = subprocess.run([str(EXE)], cwd=ROOT, timeout=15, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"{EXE.name} returned {completed.returncode}")
    def find_one_controller():
        found = controller_processes()
        return found if len(found) == 1 else None

    rows = wait_until(
        "one tray controller process",
        find_one_controller,
        timeout=15,
    )
    return rows[0]


def assert_single_instance(original_pid: int) -> None:
    completed = subprocess.run([str(EXE)], cwd=ROOT, timeout=15, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"second launcher returned {completed.returncode}")
    time.sleep(2)
    pids = [process.pid for process in controller_processes()]
    if pids != [original_pid]:
        raise AssertionError(f"expected one controller PID {original_pid}, got {pids}")


def candidate_scopes() -> Iterable[object]:
    desktop = Desktop(backend="uia")
    taskbar = desktop.window(class_name="Shell_TrayWnd")
    if taskbar.exists(timeout=1):
        yield taskbar
    for class_name in ("TopLevelWindowForOverflowXamlIsland", "NotifyIconOverflowWindow"):
        window = desktop.window(class_name=class_name)
        if window.exists(timeout=0.5) and window.is_visible():
            yield window


def find_named_button(scopes: Iterable[object], predicate: Callable[[str], bool]):
    for scope in scopes:
        try:
            buttons = scope.descendants(control_type="Button")
        except Exception:
            continue
        for button in buttons:
            try:
                if predicate(button.window_text().strip()):
                    return button
            except Exception:
                continue
    return None


def open_hidden_icons_if_needed() -> None:
    desktop = Desktop(backend="uia")
    taskbar = desktop.window(class_name="Shell_TrayWnd")
    if not taskbar.exists(timeout=2):
        raise RuntimeError("Windows taskbar was not found; use a logged-in interactive runner session")

    def is_hidden_icons_button(text: str) -> bool:
        lowered = text.casefold()
        return "hidden icon" in lowered or "show hidden" in lowered or "非表示のアイコン" in text

    button = find_named_button((taskbar,), is_hidden_icons_button)
    if button is not None:
        button.click_input()
        time.sleep(0.7)


def find_tray_button():
    def predicate(text: str) -> bool:
        return text.casefold().startswith(APP_NAME.casefold())

    button = find_named_button(candidate_scopes(), predicate)
    if button is not None:
        return button
    open_hidden_icons_if_needed()
    return wait_until(
        f"{APP_NAME} tray icon",
        lambda: find_named_button(candidate_scopes(), predicate),
        timeout=8,
    )


def find_qt_popup(pid: int) -> WindowInfo | None:
    return next(
        (
            row
            for row in enum_top_windows()
            if row.pid == pid and row.title == APP_NAME and "QWindowPopup" in row.class_name
        ),
        None,
    )


def close_popup(hwnd: int) -> None:
    if USER32.IsWindow(hwnd):
        USER32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        time.sleep(0.2)


def open_menu(pid: int):
    find_tray_button().click_input(button="right")
    popup = wait_until("Qt tray menu", lambda: find_qt_popup(pid), timeout=5)
    wrapper = Desktop(backend="uia").window(handle=popup.hwnd)
    wait_until("tray menu items", lambda: wrapper.descendants(control_type="MenuItem"), timeout=3)
    return popup, wrapper


def menu_items(wrapper) -> dict[str, object]:
    result: dict[str, object] = {}
    for item in wrapper.descendants(control_type="MenuItem"):
        text = item.window_text().strip()
        if text:
            result[text] = item
    return result


def assert_menu_contract(pid: int) -> None:
    popup, wrapper = open_menu(pid)
    try:
        items = menu_items(wrapper)
        if not any(title.startswith("Status: ") for title in items):
            raise AssertionError(f"status item missing: {sorted(items)}")
        missing = [title for title in EXPECTED_ACTIONS if title not in items]
        if missing:
            raise AssertionError(f"missing menu actions: {missing}; actual={sorted(items)}")
        disabled = [title for title in EXPECTED_ACTIONS if not items[title].is_enabled()]
        if disabled:
            raise AssertionError(f"unexpected disabled menu actions: {disabled}")
    finally:
        close_popup(popup.hwnd)


def click_menu_item(pid: int, title: str) -> None:
    popup, wrapper = open_menu(pid)
    items = menu_items(wrapper)
    item = items.get(title)
    if item is None:
        close_popup(popup.hwnd)
        raise AssertionError(f"menu item not found: {title}; actual={sorted(items)}")
    if not item.is_enabled():
        close_popup(popup.hwnd)
        raise AssertionError(f"menu item is disabled: {title}")
    item.click_input()
    wait_until("tray menu to close", lambda: not USER32.IsWindow(popup.hwnd), timeout=5)


def panel_window(pid: int) -> WindowInfo | None:
    return next(
        (
            row
            for row in enum_top_windows()
            if row.pid == pid
            and row.title == APP_NAME
            and "QWindowPopup" not in row.class_name
            and USER32.IsWindowVisible(row.hwnd)
        ),
        None,
    )


def pet_window(pid: int) -> WindowInfo | None:
    return next(
        (
            row
            for row in enum_top_windows()
            if row.pid == pid
            and row.title == PET_WINDOW_TITLE
            and USER32.IsWindowVisible(row.hwnd)
        ),
        None,
    )


def window_rect(hwnd: int) -> tuple[int, int, int, int]:
    rect = wt.RECT()
    if not USER32.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise ctypes.WinError()
    return int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)


def move_window(hwnd: int, x: int, y: int) -> None:
    flags = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
    if not USER32.SetWindowPos(hwnd, 0, int(x), int(y), 0, 0, flags):
        raise ctypes.WinError()


def assert_window_responsive(hwnd: int) -> None:
    result = ctypes.c_size_t()
    ok = USER32.SendMessageTimeoutW(hwnd, WM_NULL, 0, 0, SMTO_ABORTIFHUNG, 2000, ctypes.byref(result))
    if not ok:
        raise AssertionError(f"window {hwnd} is not responding")


def verify_panel_toggle(pid: int) -> None:
    click_menu_item(pid, "Show Local Voice panel")
    panel = wait_until("Local Voice panel", lambda: panel_window(pid), timeout=8)
    assert_window_responsive(panel.hwnd)
    click_menu_item(pid, "Hide Local Voice panel")
    wait_until("Local Voice panel to hide", lambda: panel_window(pid) is None, timeout=8)


def verify_pet_visible_and_position_reset(pid: int) -> None:
    pet = wait_until("desktop pet window", lambda: pet_window(pid), timeout=8)
    assert_window_responsive(pet.hwnd)
    original = window_rect(pet.hwnd)
    target_x, target_y = 20, 20
    move_window(pet.hwnd, target_x, target_y)

    def moved_to_test_position():
        current = window_rect(pet.hwnd)
        if abs(current[0] - target_x) <= 3 and abs(current[1] - target_y) <= 3:
            return current
        return None

    moved = wait_until("desktop pet test position", moved_to_test_position, timeout=5)
    click_menu_item(pid, "Bring Desktop Pet Back")

    def moved_from_test_position():
        current = window_rect(pet.hwnd)
        if abs(current[0] - moved[0]) > 30 or abs(current[1] - moved[1]) > 30:
            return current
        return None

    restored = wait_until("desktop pet default position", moved_from_test_position, timeout=8)
    if restored[2] <= restored[0] or restored[3] <= restored[1]:
        raise AssertionError(f"invalid restored pet bounds: {restored}")
    if original == moved:
        raise AssertionError("desktop pet did not move to the test position")


def log_tail_from(offset: int) -> str:
    if not CONTROLLER_LOG.exists():
        return ""
    with CONTROLLER_LOG.open("rb") as handle:
        handle.seek(offset)
        return handle.read().decode("utf-8", errors="replace")


def verify_restart(pid: int) -> None:
    offset = CONTROLLER_LOG.stat().st_size if CONTROLLER_LOG.exists() else 0
    click_menu_item(pid, "Restart Voice Bridge")
    wait_until(
        "restart command log entry",
        lambda: "Status: Restarting" in log_tail_from(offset),
        timeout=20,
    )
    assert_menu_contract(pid)


def verify_exit_and_relaunch(pid: int) -> int:
    click_menu_item(pid, "Exit")
    wait_until("controller process exit", lambda: not controller_processes(), timeout=15)
    next_process = launch_app()
    assert_menu_contract(next_process.pid)
    return next_process.pid


def save_result(results: list[ScenarioResult], error: BaseException | None = None) -> None:
    RESULT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "ok": error is None,
        "results": [asdict(result) for result in results],
    }
    if error is not None:
        payload["error"] = f"{type(error).__name__}: {error}"
        payload["traceback"] = traceback.format_exc()
        try:
            ImageGrab.grab(all_screens=True).save(FAILURE_SCREENSHOT)
        except Exception:
            pass
    RESULT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def run_scenario(results: list[ScenarioResult], name: str, action: Callable[[], None]) -> None:
    try:
        action()
    except Exception as exc:
        results.append(ScenarioResult(name, False, str(exc)))
        print(f"FAIL {name}: {exc}", flush=True)
        raise
    results.append(ScenarioResult(name, True))
    print(f"PASS {name}", flush=True)


def request_clean_exit(pid: int) -> None:
    try:
        click_menu_item(pid, "Exit")
        wait_until("controller process exit", lambda: not controller_processes(), timeout=10)
    except Exception:
        for process in controller_processes():
            try:
                process.terminate()
            except psutil.NoSuchProcess:
                pass


def main() -> int:
    if os.name != "nt":
        print("FAIL environment: Windows is required", flush=True)
        return 2
    if not EXE.is_file():
        print(f"FAIL environment: missing {EXE}", flush=True)
        return 2
    if controller_processes():
        print("FAIL environment: a controller from this checkout is already running", flush=True)
        return 2

    results: list[ScenarioResult] = []
    current_pid: int | None = None
    try:
        process = launch_app()
        current_pid = process.pid
        run_scenario(results, "packaged launcher starts", lambda: None)
        run_scenario(results, "tray menu contract", lambda: assert_menu_contract(current_pid))
        run_scenario(
            results,
            "desktop pet visible and position reset",
            lambda: verify_pet_visible_and_position_reset(current_pid),
        )
        run_scenario(results, "single instance", lambda: assert_single_instance(current_pid))
        run_scenario(results, "panel show hide and responsiveness", lambda: verify_panel_toggle(current_pid))
        run_scenario(results, "restart stays operable", lambda: verify_restart(current_pid))

        next_pid: list[int] = []

        def exit_relaunch() -> None:
            next_pid.append(verify_exit_and_relaunch(current_pid))

        run_scenario(results, "exit and second launch", exit_relaunch)
        current_pid = next_pid[0]
        request_clean_exit(current_pid)
        current_pid = None
        run_scenario(results, "final clean exit", lambda: None)
        save_result(results)
        return 0
    except Exception as exc:
        save_result(results, exc)
        return 1
    finally:
        if current_pid is not None:
            request_clean_exit(current_pid)


if __name__ == "__main__":
    raise SystemExit(main())
