from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SMOKE_SCRIPT = ROOT / "scripts" / "run-windows-gui-smoke.ps1"


class WindowsGuiSmokeScriptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = SMOKE_SCRIPT.read_text(encoding="utf-8-sig")

    def test_prefers_actions_configured_python_for_venv_creation(self) -> None:
        self.assertIn("$env:pythonLocation", self.script)
        self.assertIn("Join-Path $env:pythonLocation 'python.exe'", self.script)
        self.assertIn("-FilePath $configuredPython", self.script)

    def test_never_uses_unqualified_latest_python_launcher(self) -> None:
        self.assertNotIn("@('-3', '-m', 'venv'", self.script)
        self.assertIn("@('-3.11', '-m', 'venv'", self.script)

    def test_fails_when_actions_python_version_drifts(self) -> None:
        self.assertIn("$venvVersion.StartsWith('3.11.')", self.script)
        self.assertIn("GitHub Actions configured Python 3.11", self.script)


if __name__ == "__main__":
    unittest.main()
