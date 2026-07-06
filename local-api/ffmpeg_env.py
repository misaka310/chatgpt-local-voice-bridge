from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNTIME_FFMPEG_DIR = ROOT / "runtime" / "ffmpeg-shared"


def _has_shared_dlls(bin_dir: Path) -> bool:
    return (
        bin_dir.is_dir()
        and any(bin_dir.glob("avutil-*.dll"))
        and any(bin_dir.glob("avcodec-*.dll"))
        and any(bin_dir.glob("avformat-*.dll"))
    )


def find_shared_ffmpeg_bin() -> Path | None:
    env_bin = os.environ.get("LOCAL_VOICE_FFMPEG_BIN")
    if env_bin:
        candidate = Path(env_bin).expanduser()
        if _has_shared_dlls(candidate):
            return candidate

    direct = RUNTIME_FFMPEG_DIR / "bin"
    if _has_shared_dlls(direct):
        return direct

    if RUNTIME_FFMPEG_DIR.is_dir():
        for child in sorted(RUNTIME_FFMPEG_DIR.iterdir()):
            candidate = child / "bin"
            if _has_shared_dlls(candidate):
                return candidate

    return None


def configure_ffmpeg_dll_path() -> Path | None:
    bin_dir = find_shared_ffmpeg_bin()
    if not bin_dir:
        return None

    bin_text = str(bin_dir)
    path_value = os.environ.get("PATH", "")
    path_parts = path_value.split(os.pathsep) if path_value else []
    if bin_text not in path_parts:
        os.environ["PATH"] = bin_text + (os.pathsep + path_value if path_value else "")

    add_dll_directory = getattr(os, "add_dll_directory", None)
    if callable(add_dll_directory):
        add_dll_directory(bin_text)
    return bin_dir
