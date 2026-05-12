#!/usr/bin/env python3
"""Qwen3/ComfyUI-only local voice bridge API."""

from __future__ import annotations

import copy
import hashlib
import json
import mimetypes
import os
import shutil
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
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
QWEN_TEXT_FIELD = "text"
REF_TEXT_KEYS = ("ref_text", "reference_text", "referenceText")
LOAD_AUDIO_KEYS = ("audio", "filename", "file", "path")
SAVE_BASENAME_KEYS = ("filename_prefix", "filename", "output_name", "basename")

DEFAULT_CONFIG: dict[str, Any] = {
    "engine": "comfyui_qwen3",
    "host": "127.0.0.1",
    "port": 8765,
    "publicBaseUrl": "",
    "audioOutputDir": "./runtime/audio",
    "referenceAudioPath": "./reference/voice.wav",
    "referenceTextPath": "./reference/voice.txt",
    "comfyui": {
        "baseUrl": "http://127.0.0.1:8190",
        "workflowPath": "./workflows/qwen3_clone_api.json",
        "inputDir": "C:/ComfyUI/input",
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

    legacy_comfy = normalized.pop("comfyui_qwen3", None)
    if isinstance(legacy_comfy, dict):
        normalized.setdefault("comfyui", {})
        mapping = {
            "base_url": "baseUrl",
            "workflow_path": "workflowPath",
            "input_dir": "inputDir",
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
    value = str((os.getenv(name) or "")).strip()
    return int(value) if value else None


def parse_env_float(name: str) -> float | None:
    value = str((os.getenv(name) or "")).strip()
    return float(value) if value else None


def apply_env_overrides(raw: dict[str, Any]) -> dict[str, Any]:
    config = copy.deepcopy(raw)
    config.setdefault("comfyui", {})

    env_map = {
        "LOCAL_VOICE_ENGINE": ("engine", str),
        "LOCAL_VOICE_HOST": ("host", str),
        "LOCAL_VOICE_PORT": ("port", int),
        "LOCAL_VOICE_PUBLIC_BASE_URL": ("publicBaseUrl", str),
        "LOCAL_VOICE_AUDIO_OUTPUT_DIR": ("audioOutputDir", str),
        "LOCAL_VOICE_REFERENCE_AUDIO_PATH": ("referenceAudioPath", str),
        "LOCAL_VOICE_REFERENCE_TEXT_PATH": ("referenceTextPath", str),
    }
    for env_name, (field, caster) in env_map.items():
        value = os.getenv(env_name)
        if value:
            config[field] = caster(value)

    comfy_env = {
        "LOCAL_VOICE_COMFYUI_BASE_URL": ("baseUrl", str),
        "LOCAL_VOICE_COMFYUI_WORKFLOW_PATH": ("workflowPath", str),
        "LOCAL_VOICE_COMFYUI_INPUT_DIR": ("inputDir", str),
        "LOCAL_VOICE_COMFYUI_OUTPUT_DIR": ("outputDir", str),
        "LOCAL_VOICE_COMFYUI_DEFAULT_AUDIO_EXT": ("defaultAudioExt", str),
    }
    for env_name, (field, caster) in comfy_env.items():
        value = os.getenv(env_name)
        if value:
            config["comfyui"][field] = caster(value)

    timeout_sec = parse_env_int("LOCAL_VOICE_COMFYUI_TIMEOUT_SEC")
    if timeout_sec is not None:
        config["comfyui"]["timeoutSec"] = timeout_sec
    poll_interval = parse_env_float("LOCAL_VOICE_COMFYUI_POLL_INTERVAL_SEC")
    if poll_interval is not None:
        config["comfyui"]["pollIntervalSec"] = poll_interval
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


def resolve_path(root: Path, value: Any) -> Path:
    raw = str(value or "").strip()
    if not raw:
        raise BridgeError("path value is empty")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = (root / path).resolve()
    return path


def normalize_ext(value: str) -> str:
    if not value:
        return ".wav"
    return value if value.startswith(".") else f".{value}"


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
        return str(self.raw.get("engine", "comfyui_qwen3"))

    @property
    def audio_output_dir(self) -> Path:
        return resolve_path(self.root, self.raw.get("audioOutputDir", "./runtime/audio"))

    @property
    def reference_audio_path(self) -> Path:
        return resolve_path(self.root, self.raw.get("referenceAudioPath", "./reference/voice.wav"))

    @property
    def reference_text_path(self) -> Path:
        return resolve_path(self.root, self.raw.get("referenceTextPath", "./reference/voice.txt"))

    @property
    def comfyui(self) -> dict[str, Any]:
        value = self.raw.get("comfyui")
        return value if isinstance(value, dict) else {}

    @property
    def comfyui_base_url(self) -> str:
        return str(self.comfyui.get("baseUrl", "http://127.0.0.1:8190")).rstrip("/")

    @property
    def comfyui_workflow_path(self) -> Path:
        return resolve_path(self.root, self.comfyui.get("workflowPath", "./workflows/qwen3_clone_api.json"))

    @property
    def comfyui_input_dir(self) -> Path:
        return resolve_path(self.root, self.comfyui.get("inputDir", "C:/ComfyUI/input"))

    @property
    def comfyui_output_dir(self) -> Path:
        return resolve_path(self.root, self.comfyui.get("outputDir", "C:/ComfyUI/output"))

    @property
    def comfyui_timeout_sec(self) -> int:
        return int(self.comfyui.get("timeoutSec", 300))

    @property
    def comfyui_poll_interval_sec(self) -> float:
        return float(self.comfyui.get("pollIntervalSec", 1.0))

    @property
    def default_audio_ext(self) -> str:
        return normalize_ext(str(self.comfyui.get("defaultAudioExt", ".wav")))

    @property
    def debug_output_dir(self) -> Path:
        return resolve_path(self.root, "./runtime/debug")


@dataclass(frozen=True)
class ReferenceCopyDebug:
    load_audio_filename: str
    ref_audio_hash: str
    ref_audio_size: int
    ref_audio_mtime: str


@dataclass(frozen=True)
class SynthesisResult:
    audio_path: Path
    prompt: dict[str, Any]
    prompt_id: str
    history_entry: dict[str, Any]
    history_raw: dict[str, Any]
    workflow_hash: str
    patched_prompt_hash: str
    ref_text: str
    ref_text_hash: str
    ref_copy: ReferenceCopyDebug
    qwen_inputs: dict[str, Any]
    load_audio_inputs: dict[str, Any]
    save_audio_inputs: dict[str, Any]


def load_config() -> RuntimeConfig:
    cfg = RuntimeConfig(raw=load_config_raw(), root=ROOT)
    if cfg.engine != "comfyui_qwen3":
        raise BridgeError(f"unsupported engine '{cfg.engine}'. This server supports only comfyui_qwen3.")
    return cfg


def ensure_required_files(config: RuntimeConfig) -> None:
    if not config.reference_audio_path.is_file():
        raise BridgeError(f"referenceAudioPath not found: {config.reference_audio_path}")
    if not config.reference_text_path.is_file():
        raise BridgeError(f"referenceTextPath not found: {config.reference_text_path}")
    if not config.comfyui_workflow_path.is_file():
        raise BridgeError(f"workflowPath not found: {config.comfyui_workflow_path}")
    if not config.comfyui_input_dir.is_dir():
        raise BridgeError(f"comfyui.inputDir not found: {config.comfyui_input_dir}")
    if not config.comfyui_output_dir.is_dir():
        raise BridgeError(f"comfyui.outputDir not found: {config.comfyui_output_dir}")
    config.audio_output_dir.mkdir(parents=True, exist_ok=True)
    config.debug_output_dir.mkdir(parents=True, exist_ok=True)


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


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha1_bytes(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()


def sha1_text(value: str) -> str:
    return sha1_bytes(value.encode("utf-8"))


def sha1_file(path: Path) -> str:
    digest = hashlib.sha1()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def hash_json(value: Any) -> str:
    canonical = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha1_text(canonical)


def safe_request_id(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        raw = f"req-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    safe = "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in raw).strip("-")
    return safe[:120] or f"req-{uuid.uuid4().hex[:8]}"


def safe_basename(text: str, request_id: str | None = None) -> str:
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
    prefix = request_id or str(uuid.uuid4())[:8]
    safe = "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in prefix)[:32]
    return f"chatgpt-{safe}-{digest}"


def read_reference_text(path: Path) -> str:
    text = path.read_text(encoding="utf-8-sig").strip()
    if not text:
        raise BridgeError(f"referenceTextPath is empty: {path}")
    return text


def replace_tokens(value: Any, basename: str) -> Any:
    if isinstance(value, str):
        return value.replace("{{OUTPUT_BASENAME}}", basename)
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


def copy_reference_to_comfy_input(reference_audio_path: Path, comfy_input_dir: Path) -> ReferenceCopyDebug:
    comfy_input_dir.mkdir(parents=True, exist_ok=True)
    ref_hash = sha1_file(reference_audio_path)
    suffix = reference_audio_path.suffix or ".wav"
    target = (comfy_input_dir / f"voice-{ref_hash[:12]}{suffix}").resolve()
    shutil.copy2(reference_audio_path, target)
    stat = target.stat()
    return ReferenceCopyDebug(
        load_audio_filename=target.name,
        ref_audio_hash=ref_hash,
        ref_audio_size=int(stat.st_size),
        ref_audio_mtime=datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
    )


def patch_qwen_workflow(template: Any, text: str, basename: str, ref_audio_filename: str, ref_text: str) -> dict[str, Any]:
    prompt = replace_tokens(copy.deepcopy(template), basename)
    if not isinstance(prompt, dict):
        raise BridgeError("workflow JSON must be an object")

    text_patched = False
    ref_text_patched = False
    load_audio_patched = False
    save_audio_patched = False

    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type", ""))
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue

        if "Qwen3VoiceClone" in class_type and QWEN_TEXT_FIELD in inputs:
            inputs[QWEN_TEXT_FIELD] = text
            text_patched = True
            if maybe_set_first_string_field(inputs, REF_TEXT_KEYS, ref_text):
                ref_text_patched = True

        if "LoadAudio" in class_type:
            if maybe_set_first_string_field(inputs, LOAD_AUDIO_KEYS, ref_audio_filename):
                load_audio_patched = True

        if "SaveAudio" in class_type:
            if maybe_set_first_string_field(inputs, SAVE_BASENAME_KEYS, basename):
                save_audio_patched = True

    if not text_patched:
        raise BridgeError("Qwen3VoiceClone.inputs.text was not found in workflow")
    if not ref_text_patched:
        raise BridgeError("Qwen3VoiceClone ref_text field was not found in workflow")
    if not load_audio_patched:
        raise BridgeError("LoadAudio.inputs.audio field was not found in workflow")
    if not save_audio_patched:
        raise BridgeError("SaveAudio filename field was not found in workflow")
    return prompt


def first_node_inputs_by_class(prompt: dict[str, Any], class_name_fragment: str) -> dict[str, Any]:
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type", ""))
        if class_name_fragment not in class_type:
            continue
        inputs = node.get("inputs")
        if isinstance(inputs, dict):
            return inputs
    return {}


def write_json_file(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def build_summary(
    request_id: str,
    text_hash: str,
    result: SynthesisResult,
) -> dict[str, Any]:
    qwen = result.qwen_inputs
    load_audio = result.load_audio_inputs
    save_audio = result.save_audio_inputs
    audio_hash = sha1_file(result.audio_path)
    return {
        "requestId": request_id,
        "promptId": result.prompt_id,
        "textHash": text_hash,
        "refAudioHash": result.ref_copy.ref_audio_hash,
        "refTextHash": result.ref_text_hash,
        "workflowHash": result.workflow_hash,
        "patchedPromptHash": result.patched_prompt_hash,
        "seed": qwen.get("seed"),
        "generationMode": qwen.get("generation_mode"),
        "language": qwen.get("language"),
        "maxNewTokens": qwen.get("max_new_tokens"),
        "refAudioMaxSeconds": qwen.get("ref_audio_max_seconds"),
        "loadAudioFile": load_audio.get("audio") or load_audio.get("filename") or load_audio.get("file") or load_audio.get("path"),
        "saveFilenamePrefix": save_audio.get("filename_prefix")
        or save_audio.get("filename")
        or save_audio.get("output_name")
        or save_audio.get("basename"),
        "audioPath": str(result.audio_path),
        "audioHash": audio_hash,
        "audioSize": int(result.audio_path.stat().st_size),
        "createdAt": utc_now_iso(),
        "refAudioSize": result.ref_copy.ref_audio_size,
        "refAudioMtime": result.ref_copy.ref_audio_mtime,
    }


def persist_debug_bundle(
    config: RuntimeConfig,
    request_id: str,
    text: str,
    text_hash: str,
    received_at: str,
    result: SynthesisResult,
) -> None:
    base = (config.debug_output_dir / safe_request_id(request_id)).resolve()
    request_payload = {
        "requestId": request_id,
        "text": text,
        "textHash": text_hash,
        "textLength": len(text),
        "receivedAt": received_at,
    }
    summary_payload = build_summary(request_id=request_id, text_hash=text_hash, result=result)
    write_json_file(base / "request.json", request_payload)
    write_json_file(base / "prompt.json", result.prompt)
    write_json_file(base / "summary.json", summary_payload)
    write_json_file(base / "history.json", result.history_raw)


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
            node_id = payload.get("node_id")
            node_type = payload.get("node_type")
            exc_msg = payload.get("exception_message") or payload.get("exception_type") or payload
            details.append(f"node_id={node_id} node_type={node_type} error={exc_msg}")
    return " | ".join(details) or "status=error"


def wait_for_history(base_url: str, prompt_id: str, poll_interval: float, timeout_sec: int) -> tuple[dict[str, Any], dict[str, Any]]:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        body = http_json("GET", f"{base_url}/history/{prompt_id}", timeout=30)
        entry = body.get(prompt_id)
        if isinstance(entry, dict):
            error = history_error(entry)
            if error:
                raise BridgeError(f"ComfyUI history error: {error}")
            return entry, body
        time.sleep(max(0.2, poll_interval))
    raise BridgeError(f"timeout waiting for ComfyUI prompt_id={prompt_id}")


def list_audio_files(path: Path) -> list[Path]:
    if not path.exists():
        return []
    return [p.resolve() for p in path.rglob("*") if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS]


def synthesize_comfyui_qwen3(config: RuntimeConfig, text: str, request_id: str) -> SynthesisResult:
    ensure_required_files(config)
    ref_text = read_reference_text(config.reference_text_path)
    ref_copy = copy_reference_to_comfy_input(config.reference_audio_path, config.comfyui_input_dir)

    basename = safe_basename(text, request_id)
    template = load_json(config.comfyui_workflow_path)
    workflow_hash = hash_json(template)
    prompt = patch_qwen_workflow(template, text, basename, ref_copy.load_audio_filename, ref_text)
    patched_prompt_hash = hash_json(prompt)

    before = {p.as_posix() for p in list_audio_files(config.comfyui_output_dir)}
    started_at = time.time()
    body = http_json(
        "POST",
        f"{config.comfyui_base_url}/prompt",
        {"prompt": prompt, "client_id": str(uuid.uuid4())},
        timeout=30,
    )
    prompt_id = body.get("prompt_id")
    if not prompt_id:
        raise BridgeError("ComfyUI /prompt did not return prompt_id")

    entry, history_raw = wait_for_history(
        config.comfyui_base_url,
        str(prompt_id),
        config.comfyui_poll_interval_sec,
        config.comfyui_timeout_sec,
    )

    generated = extract_generated_files(entry)
    source: Path | None = None
    if generated:
        first = generated[0]
        candidate = (config.comfyui_output_dir / first.get("subfolder", "") / first["filename"]).resolve()
        if candidate.is_file():
            source = candidate

    if source is None:
        after_files = list_audio_files(config.comfyui_output_dir)
        new_files = [p for p in after_files if p.as_posix() not in before]
        recent_files = [p for p in after_files if p.stat().st_mtime >= started_at - 2.0]
        pool = new_files or recent_files or after_files
        if not pool:
            raise BridgeError("ComfyUI did not create an audio file")
        source = max(pool, key=lambda p: p.stat().st_mtime)

    suffix = source.suffix or config.default_audio_ext
    out_file = config.audio_output_dir / f"{basename}{suffix}"
    config.audio_output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, out_file)

    return SynthesisResult(
        audio_path=out_file,
        prompt=prompt,
        prompt_id=str(prompt_id),
        history_entry=entry,
        history_raw=history_raw,
        workflow_hash=workflow_hash,
        patched_prompt_hash=patched_prompt_hash,
        ref_text=ref_text,
        ref_text_hash=sha1_text(ref_text),
        ref_copy=ref_copy,
        qwen_inputs=first_node_inputs_by_class(prompt, "Qwen3VoiceClone"),
        load_audio_inputs=first_node_inputs_by_class(prompt, "LoadAudio"),
        save_audio_inputs=first_node_inputs_by_class(prompt, "SaveAudio"),
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "ChatGPTLocalVoiceBridge/0.3"

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
                ensure_required_files(config)
                json_response(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "engine": config.engine,
                        "audioOutputDir": str(config.audio_output_dir),
                        "publicBaseUrl": config.public_base_url,
                        "referenceAudioPath": str(config.reference_audio_path),
                        "referenceTextPath": str(config.reference_text_path),
                        "workflowPath": str(config.comfyui_workflow_path),
                        "comfyuiInputDir": str(config.comfyui_input_dir),
                        "comfyuiOutputDir": str(config.comfyui_output_dir),
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
            request_id = safe_request_id(str(payload.get("requestId") or ""))
            received_at = utc_now_iso()
            text_hash = sha1_text(text)
            result = synthesize_comfyui_qwen3(config, text, request_id)
            persist_debug_bundle(
                config=config,
                request_id=request_id,
                text=text,
                text_hash=text_hash,
                received_at=received_at,
                result=result,
            )
            rel_name = result.audio_path.name
            audio_url = f"{config.public_base_url}/audio/{rel_name}"
            json_response(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "engine": config.engine,
                    "requestId": request_id,
                    "audioUrl": audio_url,
                    "audioPath": str(result.audio_path),
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
        ensure_required_files(config)
        config.audio_output_dir.mkdir(parents=True, exist_ok=True)
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

