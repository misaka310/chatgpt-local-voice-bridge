from __future__ import annotations

import ctypes
import json
import logging
import logging.handlers
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

LOCAL_API_DIR = Path(__file__).resolve().parent
APP_ROOT = LOCAL_API_DIR.parent
VENV_SCRIPTS = LOCAL_API_DIR / ".venv" / "Scripts"
SERVER_PYTHON = VENV_SCRIPTS / "python.exe"
SERVER_SCRIPT = LOCAL_API_DIR / "server.py"
PREFLIGHT_SCRIPT = LOCAL_API_DIR / "scripts" / "preflight_irodori.py"
SETUP_SCRIPT = APP_ROOT / "setup-voice-env.cmd"
LAUNCHER_SCRIPT = APP_ROOT / "start-voice-bridge.vbs"
RUNTIME_DIR = LOCAL_API_DIR / "runtime"
LOG_DIR = LOCAL_API_DIR / "logs"
CONTROLLER_LOG = LOG_DIR / "controller.log"
SERVER_LOG = LOG_DIR / "server.log"
AUDIO_DIR = RUNTIME_DIR / "audio"
REFERENCE_DIR = LOCAL_API_DIR / "reference" / "voices"
HEALTH_URL = "http://127.0.0.1:8717/health"
PORT = 8717
HEALTH_INTERVAL_SECONDS = 5.0
RESTART_MIN_INTERVAL_SECONDS = 10.0
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
MUTEX_NAME = "Local\\ChatGPTLocalVoiceBridgeTray"
ERROR_ALREADY_EXISTS = 183

LOGGER = logging.getLogger("chatgpt-local-voice-bridge-tray")
_MUTEX_HANDLE: int | None = None


def configure_logging() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if LOGGER.handlers:
        return
    LOGGER.setLevel(logging.INFO)
    handler = logging.handlers.RotatingFileHandler(
        CONTROLLER_LOG,
        maxBytes=2 * 1024 * 1024,
        backupCount=2,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(asctime)s [tray] %(levelname)s %(message)s"))
    LOGGER.addHandler(handler)


def compatible_health_payload(payload: Any) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get("ok") is True
        and payload.get("runtime") == "irodori_direct"
        and payload.get("defaultModel") == "irodori-v3"
    )


def probe_health(timeout: float = 1.5) -> tuple[bool, dict[str, Any] | None]:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=timeout) as response:
            if response.status != 200:
                return False, None
            payload = json.loads(response.read().decode("utf-8"))
            return compatible_health_payload(payload), payload if isinstance(payload, dict) else None
    except (OSError, ValueError, urllib.error.URLError):
        return False, None


def port_is_open(timeout: float = 0.3) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=timeout):
            return True
    except OSError:
        return False


def server_command(python_executable: Path = SERVER_PYTHON) -> list[str]:
    return [str(python_executable), str(SERVER_SCRIPT)]


def preflight_command(python_executable: Path = SERVER_PYTHON) -> list[str]:
    return [str(python_executable), str(PREFLIGHT_SCRIPT), "--strict-cuda", "--quick"]


def startup_folder() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata and os.name == "nt":
        appdata = str(Path.home() / "AppData" / "Roaming")
    if not appdata:
        raise RuntimeError("APPDATA is not available")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def startup_entry_path() -> Path:
    return startup_folder() / "ChatGPT Local Voice Bridge.vbs"


def startup_entry_text(launcher: Path = LAUNCHER_SCRIPT) -> str:
    escaped = str(launcher).replace('"', '""')
    return (
        'Set shell = CreateObject("WScript.Shell")\r\n'
        f'shell.Run Chr(34) & "{escaped}" & Chr(34), 0, False\r\n'
    )


def is_startup_enabled() -> bool:
    try:
        return startup_entry_path().is_file()
    except RuntimeError:
        return False


def set_startup_enabled(enabled: bool) -> None:
    entry = startup_entry_path()
    if enabled:
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.write_text(startup_entry_text(), encoding="utf-8-sig")
        LOGGER.info("Enabled current-user Windows startup: %s", entry)
    elif entry.exists():
        entry.unlink()
        LOGGER.info("Disabled current-user Windows startup: %s", entry)


def open_path(path: Path) -> None:
    is_directory = path.suffix == ""
    path.mkdir(parents=True, exist_ok=True) if is_directory else path.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt" and is_directory:
        subprocess.Popen(["explorer.exe", str(path)], creationflags=CREATE_NO_WINDOW)
    elif os.name == "nt":
        os.startfile(str(path))  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["xdg-open", str(path)])


def show_message(title: str, message: str, error: bool = False) -> None:
    if os.name == "nt":
        flags = 0x10 if error else 0x40
        ctypes.windll.user32.MessageBoxW(None, message, title, flags)
    else:
        print(f"{title}: {message}", file=sys.stderr if error else sys.stdout)


def acquire_single_instance() -> bool:
    global _MUTEX_HANDLE
    if os.name != "nt":
        return True
    handle = ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if not handle:
        return False
    _MUTEX_HANDLE = int(handle)
    return ctypes.windll.kernel32.GetLastError() != ERROR_ALREADY_EXISTS


class VoiceBridgeController:
    def __init__(self) -> None:
        self._status = "Starting"
        self._status_lock = threading.Lock()
        self._operation_lock = threading.RLock()
        self._stop_event = threading.Event()
        self._monitor_thread: threading.Thread | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._server_log_handle: Any = None
        self._icon: Any = None
        self._last_start_attempt = 0.0
        self._health_failures = 0

    @property
    def status(self) -> str:
        with self._status_lock:
            return self._status

    def set_status(self, value: str) -> None:
        with self._status_lock:
            changed = value != self._status
            self._status = value
        if changed:
            LOGGER.info("Status: %s", value)
        if self._icon is not None:
            self._icon.title = f"ChatGPT Local Voice Bridge\n{value}"
            try:
                self._icon.update_menu()
            except Exception:
                LOGGER.debug("Tray menu refresh failed", exc_info=True)

    def attach_icon(self, icon: Any) -> None:
        self._icon = icon
        self.set_status(self.status)

    def start_monitor(self) -> None:
        if self._monitor_thread and self._monitor_thread.is_alive():
            return
        self._monitor_thread = threading.Thread(
            target=self._monitor_loop,
            name="voice-bridge-health-monitor",
            daemon=True,
        )
        self._monitor_thread.start()

    def _monitor_loop(self) -> None:
        self._ensure_running()
        while not self._stop_event.wait(HEALTH_INTERVAL_SECONDS):
            process = self._process
            if process is not None and process.poll() is not None:
                LOGGER.warning("Owned voice bridge exited with code %s", process.returncode)
                self._close_server_log()
                self._process = None

            healthy, _ = probe_health()
            if healthy:
                self._health_failures = 0
                self.set_status("Ready" if self._process is not None else "Ready (existing)")
                continue

            self._health_failures += 1
            if self._process is not None and self._process.poll() is None:
                self.set_status("Unhealthy")
                if self._health_failures >= 2:
                    self._restart_owned_server()
                continue

            self._ensure_running()

    def _run_preflight(self) -> bool:
        self.set_status("Checking environment")
        try:
            completed = subprocess.run(
                preflight_command(),
                cwd=LOCAL_API_DIR,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=CREATE_NO_WINDOW,
                timeout=180,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            LOGGER.error("Preflight could not run: %s", exc)
            self.set_status("Environment check failed")
            return False

        if completed.stdout:
            for line in completed.stdout.splitlines():
                LOGGER.info("[preflight] %s", line)
        if completed.returncode != 0:
            self.set_status("CUDA or model unavailable")
            return False
        return True

    def _ensure_running(self) -> None:
        with self._operation_lock:
            self._ensure_running_locked()

    def _ensure_running_locked(self) -> None:
        healthy, _ = probe_health()
        if healthy:
            self._health_failures = 0
            self.set_status("Ready" if self._process is not None else "Ready (existing)")
            return

        if port_is_open():
            self.set_status(f"Port {PORT} in use")
            return

        if not SERVER_PYTHON.is_file() or not SERVER_SCRIPT.is_file():
            self.set_status("Environment missing")
            return

        now = time.monotonic()
        if now - self._last_start_attempt < RESTART_MIN_INTERVAL_SECONDS:
            self.set_status("Waiting to retry")
            return

        self._last_start_attempt = now
        if not self._run_preflight():
            return
        self._start_owned_server()

    def _start_owned_server(self) -> None:
        if self._stop_event.is_set():
            return
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        self._server_log_handle = SERVER_LOG.open("a", encoding="utf-8")
        try:
            self._process = subprocess.Popen(
                server_command(),
                cwd=LOCAL_API_DIR,
                stdin=subprocess.DEVNULL,
                stdout=self._server_log_handle,
                stderr=subprocess.STDOUT,
                creationflags=CREATE_NO_WINDOW,
            )
        except OSError as exc:
            LOGGER.error("Failed to start local voice bridge: %s", exc)
            self._process = None
            self._close_server_log()
            self.set_status("Start failed")
            return

        LOGGER.info("Started owned local voice bridge PID %s", self._process.pid)
        self.set_status("Starting")
        for _ in range(20):
            if self._stop_event.wait(0.25):
                return
            if self._process.poll() is not None:
                LOGGER.error("Local voice bridge exited during startup with code %s", self._process.returncode)
                self._process = None
                self._close_server_log()
                self.set_status("Start failed")
                return
            healthy, _ = probe_health(timeout=0.5)
            if healthy:
                self._health_failures = 0
                self.set_status("Ready")
                return
        self.set_status("Unhealthy")

    def _close_server_log(self) -> None:
        if self._server_log_handle is not None:
            try:
                self._server_log_handle.close()
            except OSError:
                pass
            self._server_log_handle = None

    def stop_owned_server(self) -> None:
        with self._operation_lock:
            self._stop_owned_server_locked()

    def _stop_owned_server_locked(self) -> None:
        process = self._process
        self._process = None
        if process is None:
            self._close_server_log()
            return
        if process.poll() is None:
            LOGGER.info("Stopping owned local voice bridge PID %s", process.pid)
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                LOGGER.warning("Force-killing owned local voice bridge PID %s", process.pid)
                process.kill()
                process.wait(timeout=5)
        self._close_server_log()

    def _restart_owned_server(self) -> None:
        with self._operation_lock:
            if self._stop_event.is_set():
                return
            self.set_status("Restarting")
            self._stop_owned_server_locked()
            self._last_start_attempt = 0.0
            self._health_failures = 0
            self._ensure_running_locked()

    def restart_async(self, *_: Any) -> None:
        threading.Thread(target=self._restart_owned_server, name="voice-bridge-restart", daemon=True).start()

    def open_controller_log(self, *_: Any) -> None:
        configure_logging()
        open_path(CONTROLLER_LOG)

    def open_audio_folder(self, *_: Any) -> None:
        open_path(AUDIO_DIR)

    def open_reference_folder(self, *_: Any) -> None:
        open_path(REFERENCE_DIR)

    def toggle_startup(self, *_: Any) -> None:
        try:
            set_startup_enabled(not is_startup_enabled())
            if self._icon is not None:
                self._icon.update_menu()
        except OSError as exc:
            LOGGER.error("Could not update Windows startup entry: %s", exc)
            show_message("ChatGPT Local Voice Bridge", f"自動起動を変更できませんでした。\n\n{exc}", error=True)

    def exit_and_run_setup(self, *_: Any) -> None:
        if os.name != "nt" or not SETUP_SCRIPT.is_file():
            show_message("ChatGPT Local Voice Bridge", "setup-voice-env.cmd が見つかりません。", error=True)
            return
        command = f'timeout /t 2 /nobreak >nul & call "{SETUP_SCRIPT}"'
        subprocess.Popen(
            ["cmd.exe", "/c", "start", "ChatGPT Local Voice Bridge setup", "cmd.exe", "/k", command],
            cwd=APP_ROOT,
            creationflags=CREATE_NEW_PROCESS_GROUP,
        )
        self.exit_application()

    def exit_application(self, *_: Any) -> None:
        self._stop_event.set()
        self.set_status("Stopping")
        self.stop_owned_server()
        if self._icon is not None:
            self._icon.stop()


def create_icon_image() -> Any:
    from PIL import Image, ImageDraw

    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((8, 8, 56, 56), radius=14, fill=(36, 99, 235, 255))
    draw.rounded_rectangle((25, 15, 39, 38), radius=7, fill=(255, 255, 255, 255))
    draw.arc((19, 23, 45, 48), 0, 180, fill=(255, 255, 255, 255), width=4)
    draw.line((32, 48, 32, 54), fill=(255, 255, 255, 255), width=4)
    draw.line((25, 54, 39, 54), fill=(255, 255, 255, 255), width=4)
    return image


def main() -> int:
    configure_logging()
    if os.name != "nt":
        LOGGER.error("Tray mode is supported only on Windows")
        return 2
    if not acquire_single_instance():
        show_message("ChatGPT Local Voice Bridge", "すでに通知領域で起動しています。")
        return 0

    try:
        import pystray
    except ImportError as exc:
        LOGGER.error("Tray dependencies are missing: %s", exc)
        show_message(
            "ChatGPT Local Voice Bridge",
            "通知領域用の依存関係がありません。setup-voice-env.cmd をもう一度実行してください。",
            error=True,
        )
        return 2

    controller = VoiceBridgeController()
    menu = pystray.Menu(
        pystray.MenuItem(lambda _: f"Status: {controller.status}", None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Restart Voice Bridge", controller.restart_async),
        pystray.MenuItem("Open controller log", controller.open_controller_log),
        pystray.MenuItem("Open generated audio folder", controller.open_audio_folder),
        pystray.MenuItem("Open reference voices folder", controller.open_reference_folder),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(
            "Start with Windows",
            controller.toggle_startup,
            checked=lambda _: is_startup_enabled(),
        ),
        pystray.MenuItem("Exit and run environment setup", controller.exit_and_run_setup),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Exit", controller.exit_application),
    )
    icon = pystray.Icon(
        "chatgpt-local-voice-bridge",
        create_icon_image(),
        "ChatGPT Local Voice Bridge",
        menu,
    )
    controller.attach_icon(icon)

    def setup_icon(running_icon: Any) -> None:
        running_icon.visible = True
        controller.start_monitor()

    try:
        icon.run(setup=setup_icon)
    finally:
        controller.exit_application()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
