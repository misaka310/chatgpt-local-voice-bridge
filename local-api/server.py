#!/usr/bin/env python3
"""ComfyUI workflow-based local voice bridge API."""

from __future__ import annotations

import copy
import hashlib
import json
import mimetypes
import os
import re
import shutil
import sys
import time
import uuid
from dataclasses import dataclass, replace
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

DEFAULT_TEXT_CLASS_HINTS = ("Text", "TTS", "Irodori", "Prompt")
DEFAULT_TEXT_KEYS = ("text", "prompt", "sentence")
DEFAULT_SAVE_CLASS_HINTS = ("SaveAudio", "VHS_SaveAudio")
DEFAULT_SAVE_KEYS = ("filename_prefix", "filename", "output_name", "basename")
DEFAULT_REF_CLASS_HINTS = ("LoadAudio", "ReferenceAudio", "IrodoriTTSReferenceAudio", "Audio")
DEFAULT_REF_KEYS = ("ref_audio", "audio", "filename", "file", "path")
DEFAULT_REF_TEXT_CLASS_HINTS = ("ReferenceText", "RefText", "IrodoriTTSReferenceText", "VoiceClone", "Qwen3")
DEFAULT_REF_TEXT_KEYS = ("ref_text", "reference_text", "referenceText", "prompt_ref", "audio_prompt_text")
VOICE_PRESETS_DIR = ROOT / "reference" / "voice-presets"
VOICE_PRESET_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")

DEFAULT_CONFIG: dict[str, Any] = {
    "engine": "comfyui_workflow",
    "voiceProfile": "irodori-v2",
    "defaultVoiceProfile": "irodori-v2",
    "host": "127.0.0.1",
    "port": 8717,
    "publicBaseUrl": "",
    "audioOutputDir": "./runtime/audio",
    "referenceAudioPath": "./reference/voice_irodori.wav",
    "workflowPath": "./reference/tts_e2e_irodori.json",
    "preview": {
        "maxLines": 2,
        "maxChars": 80,
        "minChars": 25,
        "stableMs": 800,
    },
    "workflowPatch": {
        "text": {
            "classTypeIncludes": ["Text", "TTS", "Irodori"],
            "inputKeys": ["text", "prompt", "sentence"],
            "enabled": True,
        },
        "save": {
            "classTypeIncludes": ["SaveAudio", "VHS_SaveAudio"],
            "inputKeys": ["filename_prefix", "filename", "output_name", "basename"],
            "enabled": True,
        },
        "referenceAudio": {
            "classTypeIncludes": ["IrodoriTTSReferenceAudio", "LoadAudio", "Audio"],
            "inputKeys": ["ref_audio", "audio", "filename", "file", "path"],
            "enabled": True,
        },
    },
    "comfyui": {
        "baseUrl": "http://127.0.0.1:8288",
        "startupBat": "D:/ComfyUI_TTS_E2E_SANDBOX/start_comfyui_tts_sandbox.bat",
        "inputDir": "D:/ComfyUI_TTS_E2E_SANDBOX/ComfyUI/input",
        "outputDir": "D:/ComfyUI_TTS_E2E_SANDBOX/ComfyUI/output",
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
    if "workflow_path" in normalized and "workflowPath" not in normalized:
        normalized["workflowPath"] = normalized.pop("workflow_path")

    if str(normalized.get("engine", "")).strip() == "comfyui_qwen3":
        normalized["engine"] = "comfyui_workflow"

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

    comfy = normalized.get("comfyui")
    if isinstance(comfy, dict) and "workflowPath" in comfy and "workflowPath" not in normalized:
        normalized["workflowPath"] = comfy["workflowPath"]

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
        "LOCAL_VOICE_PROFILE": ("defaultVoiceProfile", str),
        "LOCAL_VOICE_HOST": ("host", str),
        "LOCAL_VOICE_PORT": ("port", int),
        "LOCAL_VOICE_PUBLIC_BASE_URL": ("publicBaseUrl", str),
        "LOCAL_VOICE_AUDIO_OUTPUT_DIR": ("audioOutputDir", str),
        "LOCAL_VOICE_REFERENCE_AUDIO_PATH": ("referenceAudioPath", str),
        "LOCAL_VOICE_WORKFLOW_PATH": ("workflowPath", str),
    }
    for env_name, (field, caster) in env_map.items():
        value = os.getenv(env_name)
        if value:
            config[field] = caster(value)
            if field == "defaultVoiceProfile":
                config["voiceProfile"] = caster(value)

    comfy_env = {
        "LOCAL_VOICE_COMFYUI_BASE_URL": ("baseUrl", str),
        "LOCAL_VOICE_COMFYUI_INPUT_DIR": ("inputDir", str),
        "LOCAL_VOICE_COMFYUI_OUTPUT_DIR": ("outputDir", str),
        "LOCAL_VOICE_COMFYUI_STARTUP_BAT": ("startupBat", str),
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
        merged["publicBaseUrl"] = f"http://{merged.get('host', '127.0.0.1')}:{int(merged.get('port', 8717))}"
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
        return int(self.raw.get("port", 8717))

    @property
    def public_base_url(self) -> str:
        return str(self.raw.get("publicBaseUrl", f"http://{self.host}:{self.port}")).rstrip("/")

    @property
    def engine(self) -> str:
        return str(self.raw.get("engine", "comfyui_workflow"))

    @property
    def default_voice_profile(self) -> str:
        raw_default = str(self.raw.get("defaultVoiceProfile") or "").strip()
        if raw_default:
            return raw_default

        raw_legacy = str(self.raw.get("voiceProfile") or "").strip()
        if raw_legacy:
            return raw_legacy
        return "irodori"

    @property
    def audio_output_dir(self) -> Path:
        return resolve_path(self.root, self.raw.get("audioOutputDir", "./runtime/audio"))

    @property
    def comfyui(self) -> dict[str, Any]:
        value = self.raw.get("comfyui")
        return value if isinstance(value, dict) else {}

    @property
    def comfyui_base_url(self) -> str:
        return str(self.comfyui.get("baseUrl", "http://127.0.0.1:8288")).rstrip("/")

    @property
    def comfyui_startup_bat(self) -> str:
        return str(self.comfyui.get("startupBat", "D:/ComfyUI_TTS_E2E_SANDBOX/start_comfyui_tts_sandbox.bat"))

    @property
    def comfyui_input_dir(self) -> Path:
        return resolve_path(self.root, self.comfyui.get("inputDir", "D:/ComfyUI_TTS_E2E_SANDBOX/ComfyUI/input"))

    @property
    def comfyui_output_dir(self) -> Path:
        return resolve_path(self.root, self.comfyui.get("outputDir", "D:/ComfyUI_TTS_E2E_SANDBOX/ComfyUI/output"))

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

    @property
    def voice_profiles(self) -> dict[str, dict[str, Any]]:
        raw_profiles = self.raw.get("voiceProfiles")
        if not isinstance(raw_profiles, dict):
            return {}

        profiles: dict[str, dict[str, Any]] = {}
        for key, value in raw_profiles.items():
            profile_id = str(key or "").strip()
            if not profile_id:
                continue
            if isinstance(value, dict):
                profiles[profile_id] = value
        return profiles

    def has_voice_profiles(self) -> bool:
        return bool(self.voice_profiles)

    def available_profile_ids(self) -> list[str]:
        if self.has_voice_profiles():
            return list(self.voice_profiles.keys())
        return [self.default_voice_profile]

    def profile_label(self, profile_id: str) -> str:
        profile = self.voice_profiles.get(profile_id)
        if not isinstance(profile, dict):
            return profile_id
        label = str(profile.get("label") or "").strip()
        return label or profile_id

    def resolve_profile_id(self, profile_id: str | None) -> str:
        picked = str(profile_id or "").strip()
        if not picked:
            picked = self.default_voice_profile

        if self.has_voice_profiles():
            if picked not in self.voice_profiles:
                raise BridgeError(f"unknown voiceProfile: {picked}")
            return picked

        legacy = self.default_voice_profile
        if picked != legacy:
            raise BridgeError(f"unknown voiceProfile: {picked}")
        return legacy

    def _legacy_profile_value(self, field: str, fallback: Any) -> Any:
        value = self.raw.get(field)
        if value not in (None, ""):
            return value
        if field == "workflowPath":
            return self.comfyui.get("workflowPath", fallback)
        return fallback

    def profile_config(self, profile_id: str | None) -> "ActiveVoiceProfile":
        resolved_id = self.resolve_profile_id(profile_id)

        if self.has_voice_profiles():
            profile_raw = self.voice_profiles.get(resolved_id) or {}
            reference_value = profile_raw.get("referenceAudioPath", self._legacy_profile_value("referenceAudioPath", "./reference/voice_irodori.wav"))
            workflow_value = profile_raw.get("workflowPath", self._legacy_profile_value("workflowPath", "./reference/tts_e2e_irodori.json"))
            patch_value = profile_raw.get("workflowPatch")
            if not isinstance(patch_value, dict):
                patch_value = self.raw.get("workflowPatch")
            workflow_patch = patch_value if isinstance(patch_value, dict) else {}
            label = str(profile_raw.get("label") or "").strip() or resolved_id
        else:
            reference_value = self._legacy_profile_value("referenceAudioPath", "./reference/voice_irodori.wav")
            workflow_value = self._legacy_profile_value("workflowPath", "./reference/tts_e2e_irodori.json")
            patch_value = self.raw.get("workflowPatch")
            workflow_patch = patch_value if isinstance(patch_value, dict) else {}
            label = resolved_id

        return ActiveVoiceProfile(
            id=resolved_id,
            label=label,
            reference_audio_path=resolve_path(self.root, reference_value),
            workflow_path=resolve_path(self.root, workflow_value),
            workflow_patch=workflow_patch,
        )


@dataclass(frozen=True)
class PatchSelector:
    class_type_includes: tuple[str, ...]
    input_keys: tuple[str, ...]
    enabled: bool


@dataclass(frozen=True)
class PatchTarget:
    node_id: str
    class_type: str
    input_key: str


@dataclass(frozen=True)
class ReferenceAudioDebug:
    configured_path: str
    reference_audio_hash: str
    reference_audio_size: int
    reference_audio_mtime: str
    used: bool
    input_filename: str | None
    fallback_input_filename: str | None


@dataclass(frozen=True)
class SynthesisResult:
    audio_path: Path
    prompt: dict[str, Any]
    prompt_id: str
    history_entry: dict[str, Any]
    history_raw: dict[str, Any]
    workflow_hash: str
    patched_prompt_hash: str
    tts_input_hash: str
    text_target: PatchTarget
    save_target: PatchTarget
    reference_target: PatchTarget | None
    reference_audio: ReferenceAudioDebug


@dataclass(frozen=True)
class ActiveVoiceProfile:
    id: str
    label: str
    reference_audio_path: Path
    workflow_path: Path
    workflow_patch: dict[str, Any]
    reference_text_path: Path | None = None
    voice_preset_id: str | None = None


def selector_from_config(raw: dict[str, Any], key: str, fallback_classes: tuple[str, ...], fallback_keys: tuple[str, ...], default_enabled: bool = True) -> PatchSelector:
    block = raw.get(key)
    if not isinstance(block, dict):
        return PatchSelector(fallback_classes, fallback_keys, default_enabled)

    classes = block.get("classTypeIncludes")
    input_keys = block.get("inputKeys")
    enabled = bool(block.get("enabled", default_enabled))

    class_list = tuple(str(item) for item in classes) if isinstance(classes, list) and classes else fallback_classes
    key_list = tuple(str(item) for item in input_keys) if isinstance(input_keys, list) and input_keys else fallback_keys
    return PatchSelector(class_list, key_list, enabled)


def load_config() -> RuntimeConfig:
    cfg = RuntimeConfig(raw=load_config_raw(), root=ROOT)
    if cfg.engine != "comfyui_workflow":
        raise BridgeError(f"unsupported engine '{cfg.engine}'. This server supports only comfyui_workflow.")
    return cfg


def normalize_workflow_version(raw: Any) -> str | None:
    value = str(raw or "").strip().lower()
    if not value:
        return None
    if value.startswith("irodori-"):
        tail = value.split("-", 1)[1]
        return f"irodori-{tail}" if tail else None
    if value in {"2", "v2"}:
        return "irodori-v2"
    if value in {"3", "v3"}:
        return "irodori-v3"
    return None


def resolve_voice_profile_id(config: RuntimeConfig, payload: dict[str, Any]) -> str:
    requested = str(payload.get("voiceProfile") or "").strip()
    if requested:
        return config.resolve_profile_id(requested)

    requested_version = normalize_workflow_version(payload.get("workflowVersion"))
    if requested_version:
        return config.resolve_profile_id(requested_version)
    if payload.get("workflowVersion") not in (None, ""):
        raise BridgeError(f"unknown workflowVersion: {payload.get('workflowVersion')}")
    return config.resolve_profile_id(None)


def validate_voice_preset_id(raw: Any) -> str | None:
    if raw in (None, ""):
        return None
    preset_id = str(raw).strip()
    if not preset_id:
        raise BridgeError("voicePreset is empty")
    if not VOICE_PRESET_ID_PATTERN.fullmatch(preset_id):
        raise BridgeError("invalid voicePreset; use only [A-Za-z0-9_-]")
    if "/" in preset_id or "\\" in preset_id:
        raise BridgeError("invalid voicePreset; path separators are not allowed")
    if Path(preset_id).is_absolute():
        raise BridgeError("invalid voicePreset; absolute paths are not allowed")
    return preset_id


def resolve_voice_preset_paths(preset_id: str) -> tuple[Path, Path]:
    root = VOICE_PRESETS_DIR.resolve()
    preset_dir = (root / preset_id).resolve()
    if preset_dir.parent != root:
        raise BridgeError("invalid voicePreset path")

    audio_path = (preset_dir / "voice.wav").resolve()
    text_path = (preset_dir / "voice.txt").resolve()
    if not audio_path.is_file() or not text_path.is_file():
        raise BridgeError(f"voicePreset not found or incomplete: {preset_id} (need voice.wav and voice.txt)")
    return audio_path, text_path


def resolve_speak_profile(config: RuntimeConfig, payload: dict[str, Any]) -> ActiveVoiceProfile:
    profile_id = resolve_voice_profile_id(config, payload)
    base_profile = config.profile_config(profile_id)

    preset_id = validate_voice_preset_id(payload.get("voicePreset"))
    if not preset_id:
        return base_profile

    reference_audio_path, reference_text_path = resolve_voice_preset_paths(preset_id)
    return replace(
        base_profile,
        reference_audio_path=reference_audio_path,
        reference_text_path=reference_text_path,
        voice_preset_id=preset_id,
    )


def read_reference_text(path: Path) -> str:
    value = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not value:
        raise BridgeError(f"referenceTextPath is empty: {path}")
    return value


def list_voice_presets() -> list[dict[str, Any]]:
    presets: list[dict[str, Any]] = []
    root = VOICE_PRESETS_DIR.resolve()
    if not root.exists() or not root.is_dir():
        return presets

    for child in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        if not child.is_dir():
            continue
        preset_id = child.name
        audio_path = (child / "voice.wav").resolve()
        text_path = (child / "voice.txt").resolve()
        available = VOICE_PRESET_ID_PATTERN.fullmatch(preset_id) is not None and audio_path.is_file() and text_path.is_file()
        presets.append(
            {
                "id": preset_id,
                "name": preset_id,
                "referenceAudioPath": str(audio_path),
                "referenceTextPath": str(text_path),
                "available": available,
            }
        )
    return presets


def available_voice_profiles_payload(config: RuntimeConfig) -> list[dict[str, str]]:
    payload: list[dict[str, str]] = []
    for profile_id in config.available_profile_ids():
        payload.append({"id": profile_id, "label": config.profile_label(profile_id)})
    return payload


def ensure_required_files(config: RuntimeConfig, profile: ActiveVoiceProfile) -> None:
    if not profile.workflow_path.is_file():
        raise BridgeError(f"workflowPath not found for {profile.id}: {profile.workflow_path}")
    if not profile.reference_audio_path.is_file():
        raise BridgeError(f"referenceAudioPath not found for {profile.id}: {profile.reference_audio_path}")
    if profile.reference_text_path is not None and not profile.reference_text_path.is_file():
        raise BridgeError(f"referenceTextPath not found for {profile.id}: {profile.reference_text_path}")
    if not config.comfyui_input_dir.is_dir():
        raise BridgeError(f"comfyui.inputDir not found: {config.comfyui_input_dir}")
    if not config.comfyui_output_dir.is_dir():
        raise BridgeError(f"comfyui.outputDir not found: {config.comfyui_output_dir}")

    config.audio_output_dir.mkdir(parents=True, exist_ok=True)
    config.debug_output_dir.mkdir(parents=True, exist_ok=True)


def ensure_all_profile_files(config: RuntimeConfig) -> None:
    for profile_id in config.available_profile_ids():
        ensure_required_files(config, config.profile_config(profile_id))


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


def safe_basename(text: str, request_id: str | None = None, voice_profile: str = "voice") -> str:
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
    prefix = request_id or str(uuid.uuid4())[:8]
    safe_request = "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in prefix).strip("-")
    safe_request = safe_request[:32] or f"req-{uuid.uuid4().hex[:8]}"
    safe_profile = "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in str(voice_profile or "voice")).strip("-")
    safe_profile = (safe_profile or "voice")[:40]
    return f"chatgpt-{safe_profile}-{safe_request}-{digest}"


def replace_tokens(value: Any, basename: str) -> Any:
    if isinstance(value, str):
        return value.replace("{{OUTPUT_BASENAME}}", basename)
    if isinstance(value, list):
        return [replace_tokens(item, basename) for item in value]
    if isinstance(value, dict):
        return {key: replace_tokens(item, basename) for key, item in value.items()}
    return value


def is_api_prompt_format(value: Any) -> bool:
    if not isinstance(value, dict) or not value:
        return False
    for node in value.values():
        if not isinstance(node, dict):
            return False
        if "class_type" not in node and "type" not in node:
            return False
    return True


def convert_graph_workflow_to_prompt(value: dict[str, Any]) -> dict[str, Any]:
    nodes = value.get("nodes")
    if not isinstance(nodes, list):
        raise BridgeError("workflow JSON must be API prompt object or include nodes[]")

    links = value.get("links")
    link_by_id: dict[str, tuple[str, int]] = {}
    if isinstance(links, list):
        for item in links:
            if isinstance(item, list) and len(item) >= 4:
                link_id = str(item[0])
                from_node = str(item[1])
                from_slot = int(item[2])
                link_by_id[link_id] = (from_node, from_slot)

    prompt: dict[str, Any] = {}
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id", "")).strip()
        if not node_id:
            continue
        class_type = str(node.get("class_type") or node.get("type") or "").strip()
        if not class_type:
            continue

        inputs_meta = node.get("inputs")
        widgets_values = node.get("widgets_values")
        widget_values_list = widgets_values if isinstance(widgets_values, list) else []
        widget_index = 0

        inputs: dict[str, Any] = {}
        if isinstance(inputs_meta, list):
            widget_inputs: list[tuple[str, str]] = []
            for input_meta in inputs_meta:
                if not isinstance(input_meta, dict):
                    continue
                input_name = str(input_meta.get("name") or "").strip()
                if not input_name:
                    continue

                link_ref = input_meta.get("link")
                if link_ref is not None:
                    mapped = link_by_id.get(str(link_ref))
                    if mapped:
                        inputs[input_name] = [mapped[0], mapped[1]]
                    continue

                if "widget" in input_meta:
                    input_type = str(input_meta.get("type") or "")
                    widget_inputs.append((input_name, input_type))
                    continue

                if "default" in input_meta:
                    inputs[input_name] = copy.deepcopy(input_meta["default"])

            def value_matches_input_type(expected_type: str, candidate: Any) -> bool:
                kind = expected_type.upper()
                if kind == "BOOLEAN":
                    return isinstance(candidate, bool)
                if kind in ("INT", "INTEGER"):
                    return isinstance(candidate, int) and not isinstance(candidate, bool)
                if kind in ("FLOAT", "NUMBER"):
                    return isinstance(candidate, (int, float)) and not isinstance(candidate, bool)
                if kind in ("STRING", "COMBO"):
                    return isinstance(candidate, str)
                return True

            for widget_name, widget_type in widget_inputs:
                while widget_index < len(widget_values_list):
                    candidate = widget_values_list[widget_index]
                    widget_index += 1
                    if value_matches_input_type(widget_type, candidate):
                        inputs[widget_name] = copy.deepcopy(candidate)
                        break

        prompt[node_id] = {
            "class_type": class_type,
            "inputs": inputs,
        }

    if not prompt:
        raise BridgeError("workflow conversion produced empty prompt")
    return prompt


def load_workflow_prompt(path: Path) -> tuple[Any, dict[str, Any]]:
    raw = load_json(path)
    if is_api_prompt_format(raw):
        return raw, copy.deepcopy(raw)
    if isinstance(raw, dict) and isinstance(raw.get("nodes"), list):
        return raw, convert_graph_workflow_to_prompt(raw)
    raise BridgeError("unsupported workflow JSON format")


def class_matches(class_type: str, fragments: tuple[str, ...]) -> bool:
    if not fragments:
        return True
    lowered = class_type.lower()
    return any(str(fragment).lower() in lowered for fragment in fragments)


def find_patch_target(prompt: dict[str, Any], selector: PatchSelector, purpose: str) -> PatchTarget | None:
    if not selector.enabled:
        return None

    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type", ""))
        if not class_matches(class_type, selector.class_type_includes):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key in selector.input_keys:
            if key in inputs and (isinstance(inputs.get(key), str) or inputs.get(key) is None):
                return PatchTarget(node_id=node_id, class_type=class_type, input_key=key)

    auto_keys = {
        "text": DEFAULT_TEXT_KEYS,
        "save": DEFAULT_SAVE_KEYS,
        "reference": DEFAULT_REF_KEYS,
    }.get(purpose, ())

    auto_class_hints = {
        "text": DEFAULT_TEXT_CLASS_HINTS,
        "save": DEFAULT_SAVE_CLASS_HINTS,
        "reference": DEFAULT_REF_CLASS_HINTS,
    }.get(purpose, ())

    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type", ""))
        if not class_matches(class_type, auto_class_hints):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key in auto_keys:
            if key in inputs and (isinstance(inputs.get(key), str) or inputs.get(key) is None):
                return PatchTarget(node_id=node_id, class_type=class_type, input_key=key)

    return None


def apply_patch_value(prompt: dict[str, Any], target: PatchTarget, value: Any) -> None:
    node = prompt.get(target.node_id)
    if not isinstance(node, dict):
        raise BridgeError(f"node not found while patching: {target.node_id}")
    inputs = node.get("inputs")
    if not isinstance(inputs, dict):
        raise BridgeError(f"node inputs not found while patching: {target.node_id}")
    inputs[target.input_key] = value


def copy_reference_to_comfy_input(reference_audio_path: Path, comfy_input_dir: Path) -> tuple[str, str, int, str]:
    comfy_input_dir.mkdir(parents=True, exist_ok=True)
    ref_hash = sha1_file(reference_audio_path)
    suffix = reference_audio_path.suffix or ".wav"
    target = (comfy_input_dir / f"voice_irodori-{ref_hash[:12]}{suffix}").resolve()
    shutil.copy2(reference_audio_path, target)
    stat = target.stat()
    return target.name, ref_hash, int(stat.st_size), datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()


def write_json_file(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def build_tts_input_hash(prompt: dict[str, Any], save_target: PatchTarget) -> str:
    normalized = copy.deepcopy(prompt)
    node = normalized.get(save_target.node_id)
    if isinstance(node, dict):
        inputs = node.get("inputs")
        if isinstance(inputs, dict) and save_target.input_key in inputs:
            inputs[save_target.input_key] = "__OUTPUT_BASENAME__"
    return hash_json(normalized)


def build_summary(
    config: RuntimeConfig,
    profile: ActiveVoiceProfile,
    request_id: str,
    text_hash: str,
    result: SynthesisResult,
) -> dict[str, Any]:
    audio_hash = sha1_file(result.audio_path)
    text_node = result.prompt.get(result.text_target.node_id, {}) if isinstance(result.prompt, dict) else {}
    save_node = result.prompt.get(result.save_target.node_id, {}) if isinstance(result.prompt, dict) else {}
    ref_node = result.prompt.get(result.reference_target.node_id, {}) if result.reference_target and isinstance(result.prompt, dict) else {}

    text_inputs = text_node.get("inputs") if isinstance(text_node, dict) else {}
    save_inputs = save_node.get("inputs") if isinstance(save_node, dict) else {}
    ref_inputs = ref_node.get("inputs") if isinstance(ref_node, dict) else {}

    return {
        "requestId": request_id,
        "promptId": result.prompt_id,
        "voiceProfile": profile.id,
        "voicePreset": profile.voice_preset_id,
        "engine": config.engine,
        "workflowPath": str(profile.workflow_path),
        "referenceAudioPath": str(profile.reference_audio_path),
        "referenceTextPath": str(profile.reference_text_path) if profile.reference_text_path else None,
        "textHash": text_hash,
        "workflowHash": result.workflow_hash,
        "patchedPromptHash": result.patched_prompt_hash,
        "ttsInputHash": result.tts_input_hash,
        "referenceAudioHash": result.reference_audio.reference_audio_hash,
        "referenceAudioSize": result.reference_audio.reference_audio_size,
        "referenceAudioMtime": result.reference_audio.reference_audio_mtime,
        "referenceAudioUsed": result.reference_audio.used,
        "referenceAudioInputFilename": result.reference_audio.input_filename,
        "referenceAudioFallbackInputFilename": result.reference_audio.fallback_input_filename,
        "textPatchNodeId": result.text_target.node_id,
        "textPatchClassType": result.text_target.class_type,
        "textPatchInputKey": result.text_target.input_key,
        "textPatchValueLength": len(str(text_inputs.get(result.text_target.input_key, ""))) if isinstance(text_inputs, dict) else 0,
        "savePatchNodeId": result.save_target.node_id,
        "savePatchClassType": result.save_target.class_type,
        "savePatchInputKey": result.save_target.input_key,
        "savePatchedValue": save_inputs.get(result.save_target.input_key) if isinstance(save_inputs, dict) else None,
        "referencePatchNodeId": result.reference_target.node_id if result.reference_target else None,
        "referencePatchClassType": result.reference_target.class_type if result.reference_target else None,
        "referencePatchInputKey": result.reference_target.input_key if result.reference_target else None,
        "referencePatchedValue": ref_inputs.get(result.reference_target.input_key) if result.reference_target and isinstance(ref_inputs, dict) else None,
        "audioPath": str(result.audio_path),
        "audioHash": audio_hash,
        "audioSize": int(result.audio_path.stat().st_size),
        "createdAt": utc_now_iso(),
    }


def persist_debug_bundle(
    config: RuntimeConfig,
    profile: ActiveVoiceProfile,
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
        "voiceProfile": profile.id,
        "voicePreset": profile.voice_preset_id,
        "engine": config.engine,
    }
    summary_payload = build_summary(config=config, profile=profile, request_id=request_id, text_hash=text_hash, result=result)
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


def patch_workflow_prompt(
    config: RuntimeConfig,
    profile: ActiveVoiceProfile,
    template_prompt: dict[str, Any],
    text: str,
    basename: str,
) -> tuple[dict[str, Any], PatchTarget, PatchTarget, PatchTarget | None, ReferenceAudioDebug]:
    prompt = replace_tokens(copy.deepcopy(template_prompt), basename)
    if not isinstance(prompt, dict):
        raise BridgeError("workflow prompt must be an object")

    patch_cfg = profile.workflow_patch
    text_selector = selector_from_config(
        patch_cfg,
        "text",
        DEFAULT_TEXT_CLASS_HINTS,
        DEFAULT_TEXT_KEYS,
        default_enabled=True,
    )
    save_selector = selector_from_config(
        patch_cfg,
        "save",
        DEFAULT_SAVE_CLASS_HINTS,
        DEFAULT_SAVE_KEYS,
        default_enabled=True,
    )
    reference_selector = selector_from_config(
        patch_cfg,
        "referenceAudio",
        DEFAULT_REF_CLASS_HINTS,
        DEFAULT_REF_KEYS,
        default_enabled=True,
    )
    reference_text_selector = selector_from_config(
        patch_cfg,
        "referenceText",
        DEFAULT_REF_TEXT_CLASS_HINTS,
        DEFAULT_REF_TEXT_KEYS,
        default_enabled=True,
    )

    text_target = find_patch_target(prompt, text_selector, "text")
    if text_target is None:
        raise BridgeError("text patch target was not found in workflow")
    apply_patch_value(prompt, text_target, text)

    save_target = find_patch_target(prompt, save_selector, "save")
    if save_target is None:
        raise BridgeError("save-audio patch target was not found in workflow")
    apply_patch_value(prompt, save_target, basename)

    stat = profile.reference_audio_path.stat()
    ref_hash = sha1_file(profile.reference_audio_path)
    ref_mtime = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()

    reference_target = find_patch_target(prompt, reference_selector, "reference")
    if reference_target is None:
        reference_debug = ReferenceAudioDebug(
            configured_path=str(profile.reference_audio_path),
            reference_audio_hash=ref_hash,
            reference_audio_size=int(stat.st_size),
            reference_audio_mtime=ref_mtime,
            used=False,
            input_filename=None,
            fallback_input_filename=None,
        )
    else:
        fallback_name: str | None = None
        node = prompt.get(reference_target.node_id, {})
        node_inputs = node.get("inputs") if isinstance(node, dict) else {}
        existing_value = node_inputs.get(reference_target.input_key) if isinstance(node_inputs, dict) else None
        if isinstance(existing_value, str) and existing_value.strip():
            fallback_name = Path(existing_value).name

        copied_name, copied_hash, copied_size, copied_mtime = copy_reference_to_comfy_input(profile.reference_audio_path, config.comfyui_input_dir)
        if fallback_name and fallback_name != copied_name:
            alias_target = (config.comfyui_input_dir / fallback_name).resolve()
            shutil.copy2(profile.reference_audio_path, alias_target)
        apply_patch_value(prompt, reference_target, copied_name)
        reference_debug = ReferenceAudioDebug(
            configured_path=str(profile.reference_audio_path),
            reference_audio_hash=copied_hash,
            reference_audio_size=copied_size,
            reference_audio_mtime=copied_mtime,
            used=True,
            input_filename=copied_name,
            fallback_input_filename=fallback_name,
        )

    if profile.reference_text_path is not None:
        reference_text_target = find_patch_target(prompt, reference_text_selector, "referenceText")
        if reference_text_target is not None:
            reference_text = read_reference_text(profile.reference_text_path)
            apply_patch_value(prompt, reference_text_target, reference_text)

    return prompt, text_target, save_target, reference_target, reference_debug


def synthesize_comfyui_workflow(config: RuntimeConfig, profile: ActiveVoiceProfile, text: str, request_id: str) -> SynthesisResult:
    ensure_required_files(config, profile)

    basename = safe_basename(text, request_id, profile.id)
    raw_workflow, template_prompt = load_workflow_prompt(profile.workflow_path)
    workflow_hash = hash_json(raw_workflow)

    prompt, text_target, save_target, reference_target, reference_audio = patch_workflow_prompt(
        config=config,
        profile=profile,
        template_prompt=template_prompt,
        text=text,
        basename=basename,
    )

    before = {p.as_posix() for p in list_audio_files(config.comfyui_output_dir)}
    started_at = time.time()
    prompt_for_submit = prompt
    try:
        body = http_json(
            "POST",
            f"{config.comfyui_base_url}/prompt",
            {"prompt": prompt_for_submit, "client_id": str(uuid.uuid4())},
            timeout=30,
        )
    except BridgeError as exc:
        error_text = str(exc)
        fallback_name = reference_audio.fallback_input_filename
        if reference_target and fallback_name and "Invalid audio file" in error_text:
            retry_prompt = copy.deepcopy(prompt_for_submit)
            apply_patch_value(retry_prompt, reference_target, fallback_name)
            body = http_json(
                "POST",
                f"{config.comfyui_base_url}/prompt",
                {"prompt": retry_prompt, "client_id": str(uuid.uuid4())},
                timeout=30,
            )
            prompt_for_submit = retry_prompt
        else:
            raise

    patched_prompt_hash = hash_json(prompt_for_submit)
    tts_input_hash = build_tts_input_hash(prompt_for_submit, save_target)
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

    reference_audio_final = reference_audio
    if reference_target:
        node = prompt_for_submit.get(reference_target.node_id, {})
        inputs = node.get("inputs") if isinstance(node, dict) else {}
        used_name = inputs.get(reference_target.input_key) if isinstance(inputs, dict) else None
        if isinstance(used_name, str):
            reference_audio_final = ReferenceAudioDebug(
                configured_path=reference_audio.configured_path,
                reference_audio_hash=reference_audio.reference_audio_hash,
                reference_audio_size=reference_audio.reference_audio_size,
                reference_audio_mtime=reference_audio.reference_audio_mtime,
                used=reference_audio.used,
                input_filename=used_name,
                fallback_input_filename=reference_audio.fallback_input_filename,
            )

    return SynthesisResult(
        audio_path=out_file,
        prompt=prompt_for_submit,
        prompt_id=str(prompt_id),
        history_entry=entry,
        history_raw=history_raw,
        workflow_hash=workflow_hash,
        patched_prompt_hash=patched_prompt_hash,
        tts_input_hash=tts_input_hash,
        text_target=text_target,
        save_target=save_target,
        reference_target=reference_target,
        reference_audio=reference_audio_final,
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "ChatGPTLocalVoiceBridge/0.4"

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
                ensure_all_profile_files(config)
                default_profile = config.profile_config(config.default_voice_profile)
                json_response(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "engine": config.engine,
                        "voiceProfile": default_profile.id,
                        "defaultVoiceProfile": default_profile.id,
                        "availableVoiceProfiles": available_voice_profiles_payload(config),
                        "audioOutputDir": str(config.audio_output_dir),
                        "publicBaseUrl": config.public_base_url,
                        "referenceAudioPath": str(default_profile.reference_audio_path),
                        "workflowPath": str(default_profile.workflow_path),
                        "comfyuiBaseUrl": config.comfyui_base_url,
                        "comfyuiStartupBat": config.comfyui_startup_bat,
                        "comfyuiInputDir": str(config.comfyui_input_dir),
                        "comfyuiOutputDir": str(config.comfyui_output_dir),
                    },
                )
                return

            if parsed.path == "/v1/voice-presets":
                json_response(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "presets": list_voice_presets(),
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
            profile = resolve_speak_profile(config, payload)

            result = synthesize_comfyui_workflow(config, profile, text, request_id)
            persist_debug_bundle(
                config=config,
                profile=profile,
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
                    "voiceProfile": profile.id,
                    "voicePreset": profile.voice_preset_id,
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
        ensure_all_profile_files(config)
        default_profile = config.profile_config(config.default_voice_profile)
        config.audio_output_dir.mkdir(parents=True, exist_ok=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[FATAL] {exc}", file=sys.stderr)
        return 2

    address = (config.host, config.port)
    httpd = ThreadingHTTPServer(address, Handler)
    print(f"Local Voice Bridge listening on http://{config.host}:{config.port}")
    print(f"engine={config.engine}")
    print(f"defaultVoiceProfile={default_profile.id}")
    print(f"workflowPath={default_profile.workflow_path}")
    print(f"referenceAudioPath={default_profile.reference_audio_path}")
    print(f"availableVoiceProfiles={','.join(config.available_profile_ids())}")
    print(f"audioOutputDir={config.audio_output_dir}")
    print("health: /health")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
