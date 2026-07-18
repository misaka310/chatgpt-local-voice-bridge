from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Callable

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ROOT = Path(__file__).resolve().parents[1]
LOCAL_API = ROOT / "local-api"
if str(LOCAL_API) not in sys.path:
    sys.path.insert(0, str(LOCAL_API))

import tray_controller as tray  # noqa: E402


class FakeController:
    def __init__(self, status: str = "Ready") -> None:
        self.status = status
        self.callback: Callable[[str], None] | None = None
        self.start_count = 0
        self.shutdown_count = 0
        self.restart_count = 0

    def set_status_callback(self, callback: Callable[[str], None] | None) -> None:
        self.callback = callback
        if callback is not None:
            callback(self.status)

    def start_monitor(self) -> None:
        self.start_count += 1

    def shutdown(self) -> None:
        self.shutdown_count += 1

    def restart_async(self, *_: object) -> None:
        self.restart_count += 1

    def open_controller_log(self, *_: object) -> None:
        return None

    def open_audio_folder(self, *_: object) -> None:
        return None

    def open_reference_folder(self, *_: object) -> None:
        return None

    def publish_from_worker(self, status: str) -> None:
        def worker() -> None:
            self.status = status
            if self.callback is not None:
                self.callback(status)

        thread = threading.Thread(target=worker)
        thread.start()
        thread.join(timeout=2)


class TrayQtRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = tray.create_qt_application([])

    @staticmethod
    def _create_pet_root(temp_dir: str, *, local_pets: tuple[str, ...] = ()) -> Path:
        root = Path(temp_dir) / "pet"
        root.mkdir(parents=True, exist_ok=True)
        (root / "placeholder.svg").write_text(
            '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">'
            '<circle cx="16" cy="16" r="12" fill="#4488ff"/>'
            "</svg>",
            encoding="utf-8",
        )
        (root / "pet.json").write_text(
            json.dumps(
                {
                    "id": "local-voice-placeholder",
                    "displayName": "Placeholder",
                    "spritesheetPath": "placeholder.svg",
                    "columns": 1,
                    "rows": 1,
                    "frameWidth": 32,
                    "frameHeight": 32,
                    "displayScale": 1,
                }
            ),
            encoding="utf-8",
        )
        for pet_id in local_pets:
            pet_dir = root / "local" / "voices" / pet_id
            pet_dir.mkdir(parents=True, exist_ok=True)
            (pet_dir / "sprite.svg").write_text(
                '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">'
                '<rect x="4" y="4" width="24" height="24" fill="#44aa88"/>'
                "</svg>",
                encoding="utf-8",
            )
            (pet_dir / "pet.json").write_text(
                json.dumps(
                    {
                        "id": pet_id,
                        "displayName": pet_id,
                        "spritesheetPath": "sprite.svg",
                        "columns": 1,
                        "rows": 1,
                        "frameWidth": 32,
                        "frameHeight": 32,
                        "displayScale": 1,
                    }
                ),
                encoding="utf-8",
            )
        return root

    def _create_runtime(self, temp_dir: str, controller: FakeController | None = None) -> tray.VoiceBridgeQtRuntime:
        return tray.VoiceBridgeQtRuntime(
            self.app,
            controller=controller or FakeController(),
            pet_root=self._create_pet_root(temp_dir),
            settings_path=Path(temp_dir) / "settings.json",
            start_monitor=True,
            show_tray=False,
        )

    def test_runtime_initializes_status_after_actions_exist(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime = self._create_runtime(temp_dir, FakeController("Ready"))
            self.app.processEvents()

            self.assertEqual(runtime.status_action.text(), "Status: Ready")
            self.assertEqual(runtime.pet.current_state, "idle")
            runtime.shutdown()

    def test_runtime_owns_one_pet_and_status_changes_do_not_duplicate_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = FakeController("Ready")
            runtime = self._create_runtime(temp_dir, controller)
            pet_identity = id(runtime.pet)

            controller.publish_from_worker("Unhealthy")
            self.app.processEvents()
            controller.publish_from_worker("Ready")
            self.app.processEvents()

            self.assertEqual(id(runtime.pet), pet_identity)
            self.assertEqual(runtime.pet.current_state, "idle")
            runtime.shutdown()

    def test_tray_menu_contains_service_controls_only(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            runtime = self._create_runtime(temp_dir)
            action_texts = [action.text() for action in runtime.menu.actions()]

            self.assertIn("Restart Voice Bridge", action_texts)
            self.assertIn("Exit", action_texts)
            self.assertNotIn("デスクトップペットを表示", action_texts)
            self.assertNotIn("使用するペット", action_texts)
            self.assertNotIn("ペットの位置を初期化", action_texts)
            self.assertNotIn("ペットを常に手前に表示", action_texts)
            runtime.shutdown()

    def test_monitor_starts_while_pet_stays_visible(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = FakeController()
            runtime = self._create_runtime(temp_dir, controller)
            self.app.processEvents()
            self.assertEqual(controller.start_count, 1)
            self.assertTrue(runtime.pet.isVisible())
            self.assertEqual(controller.start_count, 1)
            self.assertEqual(controller.shutdown_count, 0)
            runtime.shutdown()

    def test_external_settings_change_switches_the_running_desktop_pet(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            settings_path = Path(temp_dir) / "settings.json"
            runtime = tray.VoiceBridgeQtRuntime(
                self.app,
                controller=FakeController(),
                pet_root=self._create_pet_root(temp_dir, local_pets=("misaka", "asuka")),
                settings_path=settings_path,
                start_monitor=False,
                show_tray=False,
            )
            self.assertEqual(runtime.pet.current_pet.selection_id, "placeholder")
            settings_path.write_text(
                json.dumps({"version": 1, "selectedPetId": "misaka", "visible": True}),
                encoding="utf-8",
            )

            runtime.sync_pet_settings_from_disk()
            self.app.processEvents()

            self.assertEqual(runtime.pet.current_pet.selection_id, "misaka")
            self.assertTrue(runtime.pet.isVisible())
            runtime.shutdown()

    def test_shutdown_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            controller = FakeController()
            runtime = self._create_runtime(temp_dir, controller)
            runtime.shutdown()
            runtime.shutdown()

            self.assertEqual(controller.shutdown_count, 1)
            self.assertTrue(runtime._shutdown_started)


if __name__ == "__main__":
    unittest.main()
