from __future__ import annotations

import copy
import importlib.util
import json
import os
import sys
import tempfile
import threading
import types
import unittest
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOCAL_API = ROOT / "local-api"
SERVER_PATH = LOCAL_API / "server.py"
if str(LOCAL_API) not in sys.path:
    sys.path.insert(0, str(LOCAL_API))


def load_server_module():
    fake_engine = types.ModuleType("irodori_engine")

    class FakeIrodoriError(RuntimeError):
        pass

    fake_engine.IrodoriError = FakeIrodoriError
    fake_engine.cache_hint = lambda: "test"
    fake_engine.synthesize_irodori_direct = lambda **_: (_ for _ in ()).throw(AssertionError("not called"))
    sys.modules["irodori_engine"] = fake_engine

    spec = importlib.util.spec_from_file_location("local_voice_server_for_test", SERVER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


server = load_server_module()


class LoopbackConfigTests(unittest.TestCase):
    def config(self, **changes):
        value = copy.deepcopy(server.DEFAULT_CONFIG)
        value.update(changes)
        return value

    def test_accepts_only_documented_loopback_hosts(self):
        for host in ("127.0.0.1", "localhost", "::1"):
            with self.subTest(host=host):
                normalized = server.normalize_config(self.config(host=host))
                self.assertEqual(normalized["host"], "127.0.0.1")

    def test_rejects_wildcard_lan_and_external_hosts(self):
        for host in ("0.0.0.0", "192.168.1.20", "10.0.0.5", "example.com"):
            with self.subTest(host=host):
                with self.assertRaisesRegex(server.BridgeError, "ローカル専用"):
                    server.normalize_config(self.config(host=host))

    def test_accepts_loopback_public_base_url(self):
        normalized = server.normalize_config(
            self.config(publicBaseUrl="http://localhost:8717")
        )
        self.assertEqual(normalized["publicBaseUrl"], "http://127.0.0.1:8717")

    def test_rejects_non_loopback_public_base_url(self):
        for url in (
            "http://0.0.0.0:8717",
            "http://192.168.1.20:8717",
            "https://example.com",
            "http://example.com:8717",
        ):
            with self.subTest(url=url):
                with self.assertRaisesRegex(server.BridgeError, "ローカル専用"):
                    server.normalize_config(self.config(publicBaseUrl=url))

    def test_rejects_path_query_or_fragment(self):
        for url in (
            "http://127.0.0.1:8717/api",
            "http://127.0.0.1:8717/?token=value",
            "http://127.0.0.1:8717/#fragment",
        ):
            with self.subTest(url=url):
                with self.assertRaisesRegex(server.BridgeError, "ローカル専用"):
                    server.normalize_config(self.config(publicBaseUrl=url))


    def test_desktop_pet_id_rejects_path_like_values(self):
        for value in ("", "none", ".", "..", "../misaka", "voices/misaka", r"voices\misaka"):
            with self.subTest(value=value):
                self.assertEqual(server.normalize_desktop_pet_id(value), "placeholder")
        self.assertEqual(server.normalize_desktop_pet_id(" Misaka "), "misaka")

    def test_desktop_pet_list_includes_local_pets_without_reference_voices(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "pet"
            root.mkdir(parents=True)
            (root / "placeholder.svg").write_text(
                '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>',
                encoding="utf-8",
            )
            (root / "pet.json").write_text(
                json.dumps(
                    {
                        "id": "placeholder",
                        "displayName": "Placeholder",
                        "spritesheetPath": "placeholder.svg",
                        "columns": 1,
                        "rows": 1,
                        "frameWidth": 32,
                        "frameHeight": 32,
                    }
                ),
                encoding="utf-8",
            )
            local = root / "local" / "voices" / "standalone"
            local.mkdir(parents=True)
            (local / "sprite.svg").write_text(
                '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>',
                encoding="utf-8",
            )
            (local / "pet.json").write_text(
                json.dumps(
                    {
                        "id": "standalone",
                        "displayName": "Standalone Pet",
                        "spritesheetPath": "sprite.svg",
                        "columns": 1,
                        "rows": 1,
                        "frameWidth": 32,
                        "frameHeight": 32,
                    }
                ),
                encoding="utf-8",
            )

            pets = server.desktop_pet_list(root)

            self.assertIn({"id": "placeholder", "label": "Placeholder"}, pets)
            self.assertIn({"id": "standalone", "label": "Standalone Pet"}, pets)

    def test_desktop_pet_update_preserves_position_and_forces_visible(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "desktop-pet-settings.json"
            path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "selectedPetId": "placeholder",
                        "visible": False,
                        "x": 123,
                        "y": 456,
                        "alwaysOnTop": True,
                    }
                ),
                encoding="utf-8",
            )

            result = server.update_desktop_pet_settings("misaka", path)

            self.assertEqual(result["selectedPetId"], "misaka")
            self.assertTrue(result["visible"])
            self.assertEqual((result["x"], result["y"]), (123, 456))
            self.assertTrue(result["alwaysOnTop"])
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), result)

    def test_desktop_pet_update_recovers_from_corrupt_settings(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "desktop-pet-settings.json"
            path.write_text("not-json", encoding="utf-8")

            result = server.update_desktop_pet_settings("asuka", path)

            self.assertEqual(result["version"], 1)
            self.assertEqual(result["selectedPetId"], "asuka")
            self.assertTrue(result["visible"])


    def test_concurrent_desktop_pet_updates_leave_valid_settings(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "desktop-pet-settings.json"
            path.write_text(
                json.dumps({"version": 1, "x": 123, "y": 456, "alwaysOnTop": True}),
                encoding="utf-8",
            )
            pet_ids = ["misaka", "asuka", "placeholder"] * 8

            with ThreadPoolExecutor(max_workers=8) as executor:
                results = list(executor.map(lambda pet_id: server.update_desktop_pet_settings(pet_id, path), pet_ids))

            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertIn(saved["selectedPetId"], set(pet_ids))
            self.assertTrue(saved["visible"])
            self.assertEqual((saved["x"], saved["y"]), (123, 456))
            self.assertTrue(saved["alwaysOnTop"])
            self.assertEqual(len(results), len(pet_ids))
            self.assertEqual(list(path.parent.glob(f".{path.name}.*.tmp")), [])

    def test_desktop_pet_endpoint_updates_the_runtime_settings_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            settings_path = Path(temp_dir) / "desktop-pet-settings.json"
            previous_path = os.environ.get("LOCAL_VOICE_DESKTOP_PET_SETTINGS")
            original_load_config = server.load_config
            os.environ["LOCAL_VOICE_DESKTOP_PET_SETTINGS"] = str(settings_path)
            server.load_config = lambda: (_ for _ in ()).throw(AssertionError("not called"))
            httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{httpd.server_port}/v1/desktop-pet",
                    data=json.dumps({"petId": "misaka"}).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    payload = json.loads(response.read().decode("utf-8"))

                self.assertTrue(payload["ok"])
                self.assertEqual(payload["selectedPetId"], "misaka")
                self.assertTrue(payload["visible"])
                saved = json.loads(settings_path.read_text(encoding="utf-8"))
                self.assertEqual(saved["selectedPetId"], "misaka")
                self.assertTrue(saved["visible"])
            finally:
                httpd.shutdown()
                httpd.server_close()
                thread.join(timeout=5)
                server.load_config = original_load_config
                if previous_path is None:
                    os.environ.pop("LOCAL_VOICE_DESKTOP_PET_SETTINGS", None)
                else:
                    os.environ["LOCAL_VOICE_DESKTOP_PET_SETTINGS"] = previous_path


if __name__ == "__main__":
    unittest.main()
