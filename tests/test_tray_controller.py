from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "local-api" / "tray_controller.py"
SPEC = importlib.util.spec_from_file_location("tray_controller", MODULE_PATH)
assert SPEC and SPEC.loader
tray = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tray)


class TrayControllerContractTests(unittest.TestCase):
    def test_expected_health_payload_is_accepted(self) -> None:
        self.assertTrue(
            tray.compatible_health_payload(
                {
                    "ok": True,
                    "runtime": "irodori_direct",
                    "defaultModel": "irodori-v3",
                }
            )
        )

    def test_wrong_or_incomplete_health_payload_is_rejected(self) -> None:
        self.assertFalse(tray.compatible_health_payload({"ok": True}))
        self.assertFalse(
            tray.compatible_health_payload(
                {
                    "ok": True,
                    "runtime": "another-service",
                    "defaultModel": "irodori-v3",
                }
            )
        )
        self.assertFalse(tray.compatible_health_payload(None))

    def test_server_is_started_directly_with_the_venv_python(self) -> None:
        command = tray.server_command()
        self.assertEqual(command[0], str(tray.SERVER_PYTHON))
        self.assertEqual(command[1], str(tray.SERVER_SCRIPT))
        self.assertNotIn("cmd.exe", " ".join(command).lower())
        self.assertNotIn(".bat", " ".join(command).lower())

    def test_preflight_keeps_the_existing_cuda_contract(self) -> None:
        command = tray.preflight_command()
        self.assertIn("--strict-cuda", command)
        self.assertIn("--quick", command)
        self.assertEqual(command[0], str(tray.SERVER_PYTHON))

    def test_startup_entry_launches_the_hidden_vbs_launcher(self) -> None:
        launcher = Path(r"C:\Voice Bridge\start-voice-bridge.vbs")
        text = tray.startup_entry_text(launcher)
        self.assertIn(str(launcher), text)
        self.assertIn(", 0, False", text)

    def test_startup_toggle_is_current_user_only(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch.dict(os.environ, {"APPDATA": temp_dir}, clear=False):
                tray.set_startup_enabled(True)
                entry = tray.startup_entry_path()
                self.assertTrue(entry.is_file())
                self.assertIn("start-voice-bridge.vbs", entry.read_text(encoding="utf-8-sig"))
                tray.set_startup_enabled(False)
                self.assertFalse(entry.exists())

    def test_startup_folder_falls_back_when_appdata_is_missing(self) -> None:
        home = Path("voice-test-home")
        with (
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch.object(tray.os, "name", "nt"),
            mock.patch.object(tray.Path, "home", return_value=home),
        ):
            self.assertEqual(
                tray.startup_folder(),
                home / "AppData" / "Roaming" / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup",
            )

    def test_launcher_uses_pythonw_and_checks_tray_dependencies(self) -> None:
        launcher = (ROOT / "start-voice-bridge.vbs").read_text(encoding="utf-8")
        self.assertIn(r"\pythonw.exe", launcher)
        self.assertIn("import pystray; from PIL import Image", launcher)
        self.assertIn("shell.Run runCommand, 0, False", launcher)

    def test_launcher_is_ascii_safe_for_windows_script_host(self) -> None:
        launcher = (ROOT / "start-voice-bridge.vbs").read_text(encoding="utf-8")
        launcher.encode("ascii")

    def test_windows_directories_open_with_explicit_explorer_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir) / "generated-audio"
            with (
                mock.patch.object(tray.os, "name", "nt"),
                mock.patch.object(tray.subprocess, "Popen") as popen,
            ):
                tray.open_path(directory)
            popen.assert_called_once_with(
                ["explorer.exe", str(directory)],
                creationflags=tray.CREATE_NO_WINDOW,
            )

    def test_server_disables_only_implicit_hugging_face_tokens(self) -> None:
        source = (ROOT / "local-api" / "server.py").read_text(encoding="utf-8")
        setting = 'os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")'
        engine_import = "from irodori_engine import IrodoriError"
        self.assertIn(setting, source)
        self.assertLess(source.index(setting), source.index(engine_import))

    def test_controller_has_no_autohotkey_dependency(self) -> None:
        source = MODULE_PATH.read_text(encoding="utf-8").lower()
        self.assertNotIn("autohotkey", source)
        self.assertNotIn(".ahk", source)


if __name__ == "__main__":
    unittest.main()
