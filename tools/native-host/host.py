#!/usr/bin/env python3
"""Chrome Native Messaging host for ChatGPT Local Voice Bridge."""

from __future__ import annotations

import json
import struct
import subprocess
import sys
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = ROOT / "scripts"
START_SCRIPT = SCRIPTS_DIR / "start-local-api.ps1"
STOP_SCRIPT = SCRIPTS_DIR / "stop-local-api.ps1"
HEALTH_URL = "http://127.0.0.1:8765/health"


def send_message(message: dict) -> None:
    encoded = json.dumps(message, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def read_message() -> dict | None:
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        return None
    if len(raw_length) < 4:
        raise RuntimeError("invalid native message length")
    length = struct.unpack("<I", raw_length)[0]
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise RuntimeError("invalid native message payload")
    data = json.loads(payload.decode("utf-8"))
    return data if isinstance(data, dict) else {}


def health_status() -> dict:
    try:
        with urlopen(HEALTH_URL, timeout=2) as response:
            body = response.read().decode("utf-8")
        payload = json.loads(body or "{}")
        return {"running": bool(payload.get("ok")), "payload": payload}
    except URLError:
        return {"running": False, "payload": {}}
    except Exception as exc:  # noqa: BLE001
        return {"running": False, "error": str(exc), "payload": {}}


def run_powershell(script: Path, args: list[str] | None = None) -> subprocess.CompletedProcess[str]:
    command = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(script),
    ]
    if args:
        command.extend(args)
    return subprocess.run(command, text=True, capture_output=True, cwd=str(ROOT), timeout=30)


def handle_command(command: str) -> dict:
    if command == "status":
        status = health_status()
        if status.get("running"):
            payload = status.get("payload", {})
            return {"ok": True, "running": True, "engine": payload.get("engine", "unknown")}
        return {"ok": True, "running": False}

    if command == "start":
        if not START_SCRIPT.exists():
            return {"ok": False, "error": f"start script not found: {START_SCRIPT}"}
        result = run_powershell(START_SCRIPT, ["-Background"])
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or f"exit={result.returncode}"
            return {"ok": False, "error": detail}
        return {"ok": True, "running": True, "message": "start requested"}

    if command == "stop":
        if not STOP_SCRIPT.exists():
            return {"ok": False, "error": f"stop script not found: {STOP_SCRIPT}"}
        result = run_powershell(STOP_SCRIPT)
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or f"exit={result.returncode}"
            return {"ok": False, "error": detail}
        return {"ok": True, "running": False, "message": "stop requested"}

    return {"ok": False, "error": f"unknown command: {command}"}


def main() -> int:
    try:
        while True:
            incoming = read_message()
            if incoming is None:
                return 0
            command = str(incoming.get("command") or "")
            response = handle_command(command)
            send_message(response)
    except Exception as exc:  # noqa: BLE001
        send_message({"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
