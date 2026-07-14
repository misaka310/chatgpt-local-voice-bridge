from __future__ import annotations

import copy
import importlib.util
import sys
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "local-api" / "server.py"


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


if __name__ == "__main__":
    unittest.main()
