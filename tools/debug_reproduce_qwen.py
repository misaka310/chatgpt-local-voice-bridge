#!/usr/bin/env python3
"""Repeat the same local-api speak request and compare debug artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
LOCAL_API_URL = "http://127.0.0.1:8765/v1/speak"
DEBUG_DIR = ROOT / "local-api" / "runtime" / "debug"
REPORT_DIR = ROOT / "local-api" / "runtime" / "debug-reproduce"


def sha1_file(path: Path) -> str:
    digest = hashlib.sha1()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def http_post_json(url: str, payload: dict[str, Any], timeout_sec: int) -> dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(url, data=data, method="POST")
    request.add_header("Content-Type", "application/json; charset=utf-8")
    try:
        with urlopen(request, timeout=timeout_sec) as response:
            body = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Connection failed: {exc.reason}") from exc
    parsed = json.loads(body or "{}")
    if not isinstance(parsed, dict):
        raise RuntimeError("API returned non-object JSON")
    if not parsed.get("ok"):
        raise RuntimeError(str(parsed.get("error") or "local-api returned ok=false"))
    return parsed


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise RuntimeError(f"Expected JSON object: {path}")
    return value


def all_same(values: list[Any]) -> bool:
    return len(set(values)) <= 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Repeat same input against local-api and compare debug output.")
    parser.add_argument("--text", required=True, help="Input text to synthesize repeatedly.")
    parser.add_argument("--count", type=int, default=3, help="Repeat count (default: 3).")
    parser.add_argument("--url", default=LOCAL_API_URL, help=f"Target speak endpoint (default: {LOCAL_API_URL})")
    parser.add_argument("--timeout-sec", type=int, default=300, help="HTTP timeout seconds per request.")
    args = parser.parse_args()

    if args.count < 2:
        raise SystemExit("--count must be >= 2")

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    session_id = time.strftime("%Y%m%d-%H%M%S")
    session_dir = REPORT_DIR / f"debug-repeat-{session_id}"
    session_dir.mkdir(parents=True, exist_ok=True)

    runs: list[dict[str, Any]] = []
    for idx in range(1, args.count + 1):
        request_id = f"debug-repeat-{idx:03d}"
        payload = {"text": args.text, "requestId": request_id, "source": "debug-reproduce-script"}
        response = http_post_json(args.url, payload, timeout_sec=args.timeout_sec)
        summary_path = DEBUG_DIR / request_id / "summary.json"
        if not summary_path.is_file():
            raise RuntimeError(f"summary.json not found: {summary_path}")
        summary = load_json(summary_path)

        audio_path = Path(str(response.get("audioPath") or "")).resolve()
        if not audio_path.is_file():
            raise RuntimeError(f"Audio file not found: {audio_path}")
        audio_hash = sha1_file(audio_path)
        audio_size = audio_path.stat().st_size

        run = {
            "requestId": request_id,
            "response": response,
            "summary": summary,
            "audioPath": str(audio_path),
            "audioHashFromFile": audio_hash,
            "audioSizeFromFile": int(audio_size),
        }
        runs.append(run)

        with (session_dir / f"{request_id}.json").open("w", encoding="utf-8") as handle:
            json.dump(run, handle, ensure_ascii=False, indent=2)

    text_hashes = [run["summary"].get("textHash") for run in runs]
    ref_audio_hashes = [run["summary"].get("refAudioHash") for run in runs]
    reference_audio_used = [run["summary"].get("referenceAudioUsed") for run in runs]
    patched_prompt_hashes = [run["summary"].get("patchedPromptHash") for run in runs]
    tts_input_hashes = [run["summary"].get("ttsInputHash") for run in runs]
    seeds = [run["summary"].get("seed") for run in runs]
    audio_hashes = [run["summary"].get("audioHash") for run in runs]

    result = {
        "sessionDir": str(session_dir),
        "count": args.count,
        "same_text_hash": all_same(text_hashes),
        "same_ref_audio_hash": all_same(ref_audio_hashes),
        "same_reference_audio_used": all_same(reference_audio_used),
        "same_patched_prompt_hash": all_same(patched_prompt_hashes),
        "same_tts_input_hash": all_same(tts_input_hashes),
        "same_seed": all_same(seeds),
        "same_audio_hash": all_same(audio_hashes),
        "textHashes": text_hashes,
        "refAudioHashes": ref_audio_hashes,
        "referenceAudioUsedValues": reference_audio_used,
        "patchedPromptHashes": patched_prompt_hashes,
        "ttsInputHashes": tts_input_hashes,
        "seeds": seeds,
        "audioHashes": audio_hashes,
    }

    with (session_dir / "result.json").open("w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)

    print(f"session_dir: {session_dir}")
    print(f"same_text_hash: {str(result['same_text_hash']).lower()}")
    print(f"same_ref_audio_hash: {str(result['same_ref_audio_hash']).lower()}")
    print(f"same_reference_audio_used: {str(result['same_reference_audio_used']).lower()}")
    print(f"same_patched_prompt_hash: {str(result['same_patched_prompt_hash']).lower()}")
    print(f"same_tts_input_hash: {str(result['same_tts_input_hash']).lower()}")
    print(f"same_seed: {str(result['same_seed']).lower()}")
    print(f"same_audio_hash: {str(result['same_audio_hash']).lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
