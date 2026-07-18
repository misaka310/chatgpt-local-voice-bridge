from __future__ import annotations

import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ROOT = Path(__file__).resolve().parents[1]
LOCAL_API = ROOT / "local-api"
if str(LOCAL_API) not in sys.path:
    sys.path.insert(0, str(LOCAL_API))

import tray_controller as tray  # noqa: E402


class TrayControllerProcessTests(unittest.TestCase):
    def test_windows_mutex_rejects_second_instance(self) -> None:
        kernel32 = types.SimpleNamespace(
            CreateMutexW=mock.Mock(return_value=123),
            GetLastError=mock.Mock(return_value=tray.ERROR_ALREADY_EXISTS),
        )
        fake_windll = types.SimpleNamespace(kernel32=kernel32)
        with (
            mock.patch.object(tray, "IS_WINDOWS", True),
            mock.patch.object(tray.ctypes, "windll", fake_windll, create=True),
        ):
            self.assertFalse(tray.acquire_single_instance())

        kernel32.CreateMutexW.assert_called_once_with(None, False, tray.MUTEX_NAME)

    def test_compatible_existing_server_is_not_owned_or_terminated(self) -> None:
        controller = tray.VoiceBridgeController()
        with (
            mock.patch.object(tray, "probe_health", return_value=(True, {"ok": True})),
            mock.patch.object(tray.subprocess, "Popen") as popen,
        ):
            controller._ensure_running()
            controller.shutdown()

        self.assertEqual(controller.status, "Stopping")
        self.assertIsNone(controller._process)
        popen.assert_not_called()

    def test_owned_server_is_stopped_once_on_shutdown(self) -> None:
        process = mock.Mock()
        process.pid = 321
        process.poll.return_value = None
        controller = tray.VoiceBridgeController()
        controller._process = process

        controller.shutdown()
        controller.shutdown()

        process.terminate.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=5)


if __name__ == "__main__":
    unittest.main()
