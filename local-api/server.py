#!/usr/bin/env python3
"""Local voice bridge API for ChatGPT Web + Chrome extension."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import mimetypes
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import uuid
import wave
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
CONFIG_EXAMPLE_PATH = ROOT / "config.example.json"
CONFIG_PATH = ROOT / "config.json"
CONFIG_LOCAL_PATH = ROOT / "config.local.json"

AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}
TOKEN_OUTPUT_BASENAME = "{{OUTPUT_BASENAME}}"
QWEN_TEXT_FIELD = "text"
SAVE_BASENAME_KEYS = ("filename_prefix", "filename", "output_name", "basename")
REFERENCE_AUDIO_KEYS = (
    "reference_audio",
    "referenceAudio",
    "reference_audio_path",
    "ref_audio",
    "audio_path",
    "voice_path",
    "wav_path",
)
REFERENCE_TEXT_KEYS = (
    "reference_text",
    "referenceText",
    "reference_text_path",
    "ref_text",
    "transcript",
    "prompt",
)

DEFAULT_CONFIG: dict[str, Any] = {
    "host": "127.0.0.1",
    "port": 8765,
    "publicBaseUrl": "",
    "engine": "windows_sapi",
    "audioOutputDir": "./runtime/audio",
    "referenceAudioPath": "./reference/voice.wav",
    "referenceTextPath": "./reference/voice.txt",
    "windowsSapi": {
        "voiceName": "",
        "rate": 0,
        "volume": 100,
        "timeoutSec": 120,
    },
    "comfyui": {
        "baseUrl": "http://127.0.0.1:8188",
        "workflowPath": "./workflows/qwen3_clone_api.json",
        "outputDir": "C:/ComfyUI/output",
        "timeoutSec": 300,
        "pollIntervalSec": 1.0,
        "defaultAudioExt": ".wav",
    },
}


class BridgeError(RuntimeError):
    pass


def deep_merge(base: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    merged = copy.deepcopy(base)
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def normalize_legacy(raw: dict[str, Any]) -> dict[str, Any]:
    normalized = copy.deepcopy(raw)
    server = normalized.pop("server", None)
    if isinstance(server, dict):
        if "host" in server:
            normalized["host"] = server["host"]
        if "port" in server:
            normalized["port"] = server["port"]
        if "public_base_url" in server and "publicBaseUrl" not in normalized:
            normalized["publicBaseUrl"] = server["public_base_url"]

    if "output_dir" in normalized and "audioOutputDir" not in normalized:
        normalized["audioOutputDir"] = normalized.pop("output_dir")
    if "reference_audio_path" in normalized and "referenceAudioPath" not in normalized:
        normalized["referenceAudioPath"] = normalized.pop("reference_audio_path")
    if "reference_text_path" in normalized and "referenceTextPath" not in normalized:
        normalized["referenceTextPath"] = normalized.pop("reference_text_path")

    legacy_windows = normalized.pop("windows_sapi", None)
    if isinstance(legacy_windows, dict):
        normalized.setdefault("windowsSapi", {})
        if "voice_name" in legacy_windows:
            normalized["windowsSapi"]["voiceName"] = legacy_windows["voice_name"]
        if "rate" in legacy_windows:
            normalized["windowsSapi"]["rate"] = legacy_windows["rate"]
        if "volume" in legacy_windows:
            normalized["windowsSapi"]["volume"] = legacy_windows["volume"]
        if "timeout_sec" in legacy_windows:
            normalized["windowsSapi"]["timeoutSec"] = legacy_windows["timeout_sec"]

    legacy_comfy = normalized.pop("comfyui_qwen3", None)
    if isinstance(legacy_comfy, dict):
        normalized.setdefault("comfyui", {})
        mapping = {
            "base_url": "baseUrl",
            "workflow_path": "workflowPath",
            "comfy_output_dir": "outputDir",
            "timeout_sec": "timeoutSec",
            "poll_interval_sec": "pollIntervalSec",
            "default_audio_ext": "defaultAudioExt",
        }
        for old_key, new_key in mapping.items():
            if old_key in legacy_comfy:
                normalized["comfyui"][new_key] = legacy_comfy[old_key]
    return normalized


def parse_env_int(name: str) -> int | None:
    value = os.getenv(name)
    if value is None or value == "":
        return None
    return int(value)


def parse_env_float(name: str) -> float | None:
    value = os.getenv(name)
    if value is None or value == "":
        return None
    return float(value)


def apply_env_overrides(raw: dict[str, Any]) -> dict[str, Any]:
    config = copy.deepcopy(raw)
    config.setdefault("windowsSapi", {})
    config.setdefault("comfyui", {})

    env_map = {
        "LOCAL_VOICE_HOST": ("host", str),
        "LOCAL_VOICE_PORT": ("port", int),
        "LOCAL_VOICE_PUBLIC_BASE_URL": ("publicBaseUrl", str),
        "LOCAL_VOICE_ENGINE": ("engine", str),
        "LOCAL_VOICE_AUDIO_OUTPUT_DIR": ("audioOutputDir", str),
        "LOCAL_VOICE_REFERENCE_AUDIO_PATH": ("referenceAudioPath", str),
        "LOCAL_VOICE_REFERENCE_TEXT_PATH": ("referenceTextPath", str),
    }
    for env_name, (field, caster) in env_map.items():
        value = os.getenv(env_name)
        if value is None or value == "":
            continue
        config[field] = caster(value)

    comfy_overrides = {
        "LOCAL_VOICE_COMFYUI_BASE_URL": ("baseUrl", str),
        "LOCAL_VOICE_COMFYUI_WORKFLOW_PATH": ("workflowPath", str),
        "LOCAL_VOICE_COMFYUI_OUTPUT_DIR": ("outputDir", str),
        "LOCAL_VOICE_COMFYUI_DEFAULT_AUDIO_EXT": ("defaultAudioExt", str),
    }
    for env_name, (field, caster) in comfy_overrides.items():
        value = os.getenv(env_name)
        if value is None or value == "":
            continue
        config["comfyui"][field] = caster(value)

    timeout_sec = parse_env_int("LOCAL_VOICE_COMFYUI_TIMEOUT_SEC")
    if timeout_sec is not None:
        config["comfyui"]["timeoutSec"] = timeout_sec
    poll_interval = parse_env_float("LOCAL_VOICE_COMFYUI_POLL_INTERVAL_SEC")
    if poll_interval is not None:
        config["comfyui"]["pollIntervalSec"] = poll_interval

    voice_name = os.getenv("LOCAL_VOICE_SAPI_VOICE")
    if voice_name:
        config["windowsSapi"]["voiceName"] = voice_name
    rate = parse_env_int("LOCAL_VOICE_SAPI_RATE")
    if rate is not None:
        config["windowsSapi"]["rate"] = rate
    volume = parse_env_int("LOCAL_VOICE_SAPI_VOLUME")
    if volume is not None:
        config["windowsSapi"]["volume"] = volume
    sapi_timeout = parse_env_int("LOCAL_VOICE_SAPI_TIMEOUT_SEC")
    if sapi_timeout is not None:
        config["windowsSapi"]["timeoutSec"] = sapi_timeout
    return config


def load_config_raw() -> dict[str, Any]:
    merged = copy.deepcopy(DEFAULT_CONFIG)
    for path in (CONFIG_EXAMPLE_PATH, CONFIG_PATH, CONFIG_LOCAL_PATH):
        if path.exists():
            loaded = load_json(path)
            if not isinstance(loaded, dict):
                raise BridgeError(f"config must be JSON object: {path}")
            merged = deep_merge(merged, normalize_legacy(loaded))
    merged = apply_env_overrides(merged)
    if not merged.get("publicBaseUrl"):
        merged["publicBaseUrl"] = f"http://{merged.get('host', '127.0.0.1')}:{int(merged.get('port', 8765))}"
    return merged


def resolve_optional_path(root: Path, value: Any) -> Path | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = (root / path).resolve()
    return path if path.exists() else None


@dataclass(frozen=True)
class RuntimeConfig:
    raw: dict[str, Any]
    root: Path

    @property
    def host(self) -> str:
        return str(self.raw.get("host", "127.0.0.1"))

    @property
    def port(self) -> int:
        return int(self.raw.get("port", 8765))

    @property
    def public_base_url(self) -> str:
        return str(self.raw.get("publicBaseUrl", f"http://{self.host}:{self.port}")).rstrip("/")

    @property
    def engine(self) -> str:
        return str(self.raw.get("engine", "windows_sapi"))

    @property
    def audio_output_dir(self) -> Path:
        value = str(self.raw.get("audioOutputDir", "./runtime/audio"))
        path = Path(value).expanduser()
        if not path.is_absolute():
            path = (self.root / path).resolve()
        return path

    @property
    def reference_audio_path(self) -> Path | None:
        return resolve_optional_path(self.root, self.raw.get("referenceAudioPath"))

    @property
    def reference_text_path(self) -> Path | None:
        return resolve_optional_path(self.root, self.raw.get("referenceTextPath"))

    @property
    def windows_sapi(self) -> dict[str, Any]:
        value = self.raw.get("windowsSapi")
        return value if isinstance(value, dict) else {}

    @property
    def comfyui(self) -> dict[str, Any]:
        value = self.raw.get("comfyui")
        return value if isinstance(value, dict) else {}


def load_config() -> RuntimeConfig:
    return RuntimeConfig(raw=load_config_raw(), root=ROOT)


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.end_headers()
    handler.wfile.write(body)


def read_request_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise BridgeError(f"invalid JSON request: {exc}") from exc
    if not isinstance(payload, dict):
        raise BridgeError("request JSON must be an object")
    return payload


def sanitize_text(text: Any) -> str:
    if text is None:
        raise BridgeError("text is required")
    value = str(text).replace("\r\n", "\n").replace("\r", "\n").strip()
    if not value:
        raise BridgeError("text is empty")
    if len(value) > 12000:
        raise BridgeError("text is too long; split it before sending")
    return value


def safe_basename(text: str, request_id: str | None = None) -> str:
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
    prefix = request_id or str(uuid.uuid4())[:8]
    safe = "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in prefix)[:32]
    return f"chatgpt-{safe}-{digest}"


def ensure_output_dir(config: RuntimeConfig) -> Path:
    out_dir = config.audio_output_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def synthesize_windows_sapi(config: RuntimeConfig, text: str, request_id: str | None) -> Path:
    if os.name != "nt":
        raise BridgeError("windows_sapi engine requires Windows. Set engine to mock_wav or comfyui_qwen3.")

    settings = config.windows_sapi
    voice_name = str(settings.get("voiceName", "") or "")
    rate = int(settings.get("rate", 0))
    volume = int(settings.get("volume", 100))
    timeout_sec = int(settings.get("timeoutSec", 120))

    out_file = ensure_output_dir(config) / f"{safe_basename(text, request_id)}.wav"
    script = ROOT / "scripts" / "sapi_to_wav.ps1"
    if not script.exists():
        raise BridgeError(f"PowerShell script not found: {script}")

    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False) as handle:
        handle.write(text)
        text_path = Path(handle.name)

    command = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(script),
        "-TextFile",
        str(text_path),
        "-OutFile",
        str(out_file),
        "-Rate",
        str(rate),
        "-Volume",
        str(volume),
    ]
    if voice_name:
        command.extend(["-VoiceName", voice_name])

    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout_sec)
    finally:
        try:
            text_path.unlink(missing_ok=True)
        except OSError:
            pass

    if completed.returncode != 0:
        raise BridgeError(
            "Windows SAPI synthesis failed: "
            + (completed.stderr.strip() or completed.stdout.strip() or f"exit={completed.returncode}")
        )
    if not out_file.exists() or out_file.stat().st_size == 0:
        raise BridgeError("Windows SAPI did not create an audio file")
    return out_file


def synthesize_mock_wav(config: RuntimeConfig, text: str, request_id: str | None) -> Path:
    out_file = ensure_output_dir(config) / f"{safe_basename(text, request_id)}.wav"
    duration_sec = min(4.0, max(0.6, len(text) / 80.0))
    sample_rate = 22050
    frames = int(duration_sec * sample_rate)
    with wave.open(str(out_file), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        for i in range(frames):
            tone = math.sin(2 * math.pi * 440 * i / sample_rate)
            value = int(16000 * tone)
            wav.writeframesraw(struct.pack("<h", value))
    return out_file


def normalize_ext(value: str) -> str:
    if not value:
        return ".wav"
    return value if value.startswith(".") else f".{value}"


def replace_tokens(value: Any, basename: str) -> Any:
    if isinstance(value, str):
        return value.replace(TOKEN_OUTPUT_BASENAME, basename)
    if isinstance(value, list):
        return [replace_tokens(item, basename) for item in value]
    if isinstance(value, dict):
        return {key: replace_tokens(item, basename) for key, item in value.items()}
    return value


def maybe_set_first_string_field(inputs: dict[str, Any], candidate_keys: tuple[str, ...], value: str) -> bool:
    for key in candidate_keys:
        if key in inputs and (isinstance(inputs.get(key), str) or inputs.get(key) is None):
            inputs[key] = value
            return True
    return False


def patch_reference_fields(inputs: dict[str, Any], path: Path | None, candidate_keys: tuple[str, ...]) -> bool:
    if path is None:
        return False
    return maybe_set_first_string_field(inputs, candidate_keys, str(path))


def patch_qwen_workflow(template: Any, text: str, basename: str, reference_audio: Path | None, reference_text: Path | None) -> dict[str, Any]:
    prompt = replace_tokens(copy.deepcopy(template), basename)
    if not isinstance(prompt, dict):
        raise BridgeError("workflow JSON must be an object")

    text_patched = False
    basename_patched = False
    has_basename_token = TOKEN_OUTPUT_BASENAME in json.dumps(template, ensure_ascii=False)

    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type", ""))
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue

        if "Qwen3VoiceClone" in class_type and QWEN_TEXT_FIELD in inputs:
            if not isinstance(inputs.get(QWEN_TEXT_FIELD), str) and inputs.get(QWEN_TEXT_FIELD) is not None:
                raise BridgeError("Qwen3VoiceClone.inputs.text must be string or null")
            inputs[QWEN_TEXT_FIELD] = text
            text_patched = True
            patch_reference_fields(inputs, reference_audio, REFERENCE_AUDIO_KEYS)
            patch_reference_fields(inputs, reference_text, REFERENCE_TEXT_KEYS)

        if "LoadAudio" in class_type:
            patch_reference_fields(inputs, reference_audio, ("audio", "path", "filename", "file", *REFERENCE_AUDIO_KEYS))

        if "LoadText" in class_type:
            patch_reference_fields(inputs, reference_text, ("text", "path", "filename", "file", *REFERENCE_TEXT_KEYS))

        if "SaveAudio" in class_type:
            basename_patched = maybe_set_first_string_field(inputs, SAVE_BASENAME_KEYS, basename) or basename_patched

    if not text_patched:
        raise BridgeError("Qwen3VoiceClone.inputs.text was not found in workflow")
    if not basename_patched and not has_basename_token:
        raise BridgeError("SaveAudio basename was not patched; add SaveAudio field or {{OUTPUT_BASENAME}} token")
    return prompt


def http_json(method: str, url: str, payload: dict[str, Any] | None = None, timeout: int = 30) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(url, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise BridgeError(f"HTTP {exc.code} from {url}: {detail}") from exc
    except URLError as exc:
        raise BridgeError(f"cannot connect to {url}: {exc.reason}") from exc
    parsed = json.loads(body or "{}")
    if not isinstance(parsed, dict):
        raise BridgeError(f"unexpected JSON response from {url}")
    return parsed


def extract_generated_files(history_entry: dict[str, Any]) -> list[dict[str, str]]:
    outputs = history_entry.get("outputs")
    if not isinstance(outputs, dict):
        return []
    found: list[dict[str, str]] = []
    for node in outputs.values():
        if not isinstance(node, dict):
            continue
        for key in ("audio", "files"):
            payload = node.get(key)
            if not isinstance(payload, list):
                continue
            for item in payload:
                if not isinstance(item, dict):
                    continue
                filename = item.get("filename")
                if filename:
                    found.append(
                        {
                            "filename": str(filename),
                            "subfolder": str(item.get("subfolder", "")),
                            "type": str(item.get("type", "output")),
                        }
                    )
    return found


def history_status(entry: dict[str, Any]) -> str:
    status = entry.get("status")
    if not isinstance(status, dict):
        return "unknown"
    return str(status.get("status_str") or status.get("status") or "unknown")


def history_error(entry: dict[str, Any]) -> str | None:
    if history_status(entry).lower() != "error":
        return None
    status = entry.get("status")
    if not isinstance(status, dict):
        return "status=error"
    messages = status.get("messages")
    if not isinstance(messages, list):
        return "status=error; messages unavailable"
    details: list[str] = []
    for message in messages:
        if isinstance(message, list) and len(message) >= 2 and isinstance(message[1], dict):
            payload = message[1]
            details.append(str(payload.get("exception_message") or payload.get("exception_type") or payload))
    return " | ".join(details) or "status=error"


def wait_for_history(base_url: str, prompt_id: str, poll_interval: float, timeout_sec: int) -> dict[str, Any]:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        body = http_json("GET", f"{base_url}/history/{prompt_id}", timeout=30)
        entry = body.get(prompt_id)
        if isinstance(entry, dict):
            error = history_error(entry)
            if error:
                raise BridgeError(f"ComfyUI history error: {error}")
            return entry
        time.sleep(max(0.2, poll_interval))
    raise BridgeError(f"timeout waiting for ComfyUI prompt_id={prompt_id}")


def list_audio_files(path: Path) -> list[Path]:
    if not path.exists():
        return []
    return [p.resolve() for p in path.rglob("*") if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS]


def synthesize_comfyui_qwen3(config: RuntimeConfig, text: str, request_id: str | None) -> Path:
    settings = config.comfyui
    base_url = str(settings.get("baseUrl", "http://127.0.0.1:8188")).rstrip("/")
    workflow_path = Path(str(settings.get("workflowPath", "./workflows/qwen3_clone_api.json"))).expanduser()
    if not workflow_path.is_absolute():
        workflow_path = (ROOT / workflow_path).resolve()
    comfy_output_dir = Path(str(settings.get("outputDir", "C:/ComfyUI/output"))).expanduser()
    poll_interval = float(settings.get("pollIntervalSec", 1.0))
    timeout_sec = int(settings.get("timeoutSec", 300))
    default_ext = normalize_ext(str(settings.get("defaultAudioExt", ".wav")))

    if not workflow_path.exists():
        raise BridgeError(f"workflow file not found: {workflow_path}")
    if not comfy_output_dir.exists():
        raise BridgeError(f"ComfyUI output dir not found: {comfy_output_dir}")

    basename = safe_basename(text, request_id)
    template = load_json(workflow_path)
    prompt = patch_qwen_workflow(template, text, basename, config.reference_audio_path, config.reference_text_path)

    before = {p.as_posix() for p in list_audio_files(comfy_output_dir)}
    started_at = time.time()
    body = http_json("POST", f"{base_url}/prompt", {"prompt": prompt, "client_id": str(uuid.uuid4())}, timeout=30)
    prompt_id = body.get("prompt_id")
    if not prompt_id:
        raise BridgeError("ComfyUI /prompt did not return prompt_id")

    entry = wait_for_history(base_url, str(prompt_id), poll_interval, timeout_sec)
    generated = extract_generated_files(entry)
    source: Path | None = None
    if generated:
        first = generated[0]
        candidate = (comfy_output_dir / first.get("subfolder", "") / first["filename"]).resolve()
        if candidate.exists():
            source = candidate

    if source is None:
        after_files = list_audio_files(comfy_output_dir)
        new_files = [p for p in after_files if p.as_posix() not in before]
        recent_files = [p for p in after_files if p.stat().st_mtime >= started_at - 2.0]
        pool = new_files or recent_files or after_files
        if not pool:
            raise BridgeError("ComfyUI did not create an audio file")
        source = max(pool, key=lambda p: p.stat().st_mtime)

    suffix = source.suffix or default_ext
    out_file = ensure_output_dir(config) / f"{basename}{suffix}"
    shutil.copy2(source, out_file)
    return out_file


def synthesize(config: RuntimeConfig, text: str, request_id: str | None) -> Path:
    engine = config.engine
    if engine == "windows_sapi":
        return synthesize_windows_sapi(config, text, request_id)
    if engine == "comfyui_qwen3":
        return synthesize_comfyui_qwen3(config, text, request_id)
    if engine == "mock_wav":
        return synthesize_mock_wav(config, text, request_id)
    raise BridgeError(f"unknown engine: {engine}")


class Handler(BaseHTTPRequestHandler):
    server_version = "ChatGPTLocalVoiceBridge/0.2"

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            config = load_config()
            if parsed.path == "/health":
                json_response(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "engine": config.engine,
                        "audioOutputDir": str(config.audio_output_dir),
                        "publicBaseUrl": config.public_base_url,
                        "referenceAudioPath": str(config.reference_audio_path) if config.reference_audio_path else "",
                        "referenceTextPath": str(config.reference_text_path) if config.reference_text_path else "",
                    },
                )
                return
            if parsed.path.startswith("/audio/"):
                self.serve_audio(config, parsed.path[len("/audio/") :])
                return
            json_response(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
        except Exception as exc:  # noqa: BLE001
            json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/v1/speak":
            json_response(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        try:
            config = load_config()
            payload = read_request_json(self)
            text = sanitize_text(payload.get("text"))
            request_id = str(payload.get("requestId") or "") or None
            source_file = synthesize(config, text, request_id)
            rel_name = source_file.name
            audio_url = f"{config.public_base_url}/audio/{rel_name}"
            json_response(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "engine": config.engine,
                    "requestId": request_id,
                    "audioUrl": audio_url,
                    "audioPath": str(source_file),
                    "textLength": len(text),
                },
            )
        except BridgeError as exc:
            json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

    def serve_audio(self, config: RuntimeConfig, name: str) -> None:
        safe_name = Path(unquote(name)).name
        path = config.audio_output_dir / safe_name
        if not path.exists() or not path.is_file():
            json_response(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "audio not found"})
            return
        content_type_map = {
            ".wav": "audio/wav",
            ".mp3": "audio/mpeg",
            ".flac": "audio/flac",
            ".ogg": "audio/ogg",
            ".m4a": "audio/mp4",
            ".aac": "audio/aac",
        }
        content_type = content_type_map.get(path.suffix.lower()) or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


def main() -> int:
    try:
        config = load_config()
        ensure_output_dir(config)
    except Exception as exc:  # noqa: BLE001
        print(f"[FATAL] {exc}", file=sys.stderr)
        return 2

    address = (config.host, config.port)
    httpd = ThreadingHTTPServer(address, Handler)
    print(f"Local Voice Bridge listening on http://{config.host}:{config.port}")
    print(f"engine={config.engine}")
    print(f"audioOutputDir={config.audio_output_dir}")
    print("health: /health")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
