#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
import mimetypes
import os
import sys
import threading
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

# Public model downloads must not be broken by a stale token saved by another
# Hugging Face login. Explicit environment settings still take precedence.
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")

from control_state import ControlStateStore
from desktop_pet_config import discover_available_pets
from irodori_engine import IrodoriError, cache_hint, synthesize_irodori_direct

ROOT = Path(__file__).resolve().parent
DESKTOP_PET_SETTINGS_PATH = Path(
    os.environ.get("LOCAL_VOICE_DESKTOP_PET_SETTINGS") or ROOT / "runtime" / "desktop-pet-settings.json"
).expanduser().resolve()
CONTROL_PANEL_STATE_PATH = ROOT / "runtime" / "control-panel-state.json"
DESKTOP_PET_ROOT = ROOT.parent / "extension" / "assets" / "pet"
DESKTOP_PET_SETTINGS_LOCK = threading.Lock()
CONTROL_STATE = ControlStateStore(
    Path(os.environ.get("LOCAL_VOICE_CONTROL_STATE") or CONTROL_PANEL_STATE_PATH).expanduser().resolve()
)
AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}
TEXT_FILES = ("voice.txt", "text.txt", "transcript.txt")
DEFAULT_CONFIG: dict[str, Any] = {
    "engine": "irodori_direct",
    "host": "127.0.0.1",
    "port": 8717,
    "publicBaseUrl": "",
    "audioOutputDir": "./runtime/audio",
    "defaultModel": "irodori-v3",
    "models": {"irodori-v3": {"label": "Irodori v3 direct", "runtime": "irodori_direct", "hfCheckpoint": "Aratako/Irodori-TTS-500M-v3"}},
    "referenceVoicesDir": "./reference/voices",
    "irodori": {
        "hfCheckpoint": "Aratako/Irodori-TTS-500M-v3",
        "codecRepo": "Aratako/Semantic-DACVAE-Japanese-32dim",
        "modelDevice": "auto",
        "codecDevice": "auto",
        "modelPrecision": "auto",
        "codecPrecision": "auto",
        "requireCuda": True,
        "numSteps": 16,
        "tScheduleMode": "sway",
        "swayCoeff": -1.0,
        "durationScale": 1.0,
        "decodeMode": "sequential",
        "contextKvCache": True,
        "releaseUnusedCudaCache": True,
    },
}
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


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


def normalize_config(config: dict[str, Any]) -> dict[str, Any]:
    # This API accepts text and can serve locally generated voice audio.  It is
    # intentionally a same-PC service, never a LAN or public endpoint.
    host = str(config.get("host") or "127.0.0.1").strip().lower()
    if host not in LOOPBACK_HOSTS:
        raise BridgeError("このAPIはローカル専用です。host は 127.0.0.1、localhost、::1 のいずれかにしてください")
    config["host"] = "127.0.0.1" if host in {"localhost", "::1"} else host
    public_base_url = str(config.get("publicBaseUrl") or "").strip()
    if public_base_url:
        parsed = urlparse(public_base_url)
        if parsed.scheme != "http" or parsed.hostname not in LOOPBACK_HOSTS:
            raise BridgeError("このAPIはローカル専用です。publicBaseUrl は loopback の http URL にしてください")
        if parsed.path not in {"", "/"} or parsed.params or parsed.query or parsed.fragment:
            raise BridgeError("このAPIはローカル専用です。publicBaseUrl に path、query、fragment は指定できません")
        config["publicBaseUrl"] = f"http://127.0.0.1:{parsed.port or config.get('port', 8717)}"
    config["engine"] = "irodori_direct"
    existing = config.get("models") if isinstance(config.get("models"), dict) else {}
    irodori_model = copy.deepcopy(DEFAULT_CONFIG["models"]["irodori-v3"])
    if isinstance(existing.get("irodori-v3"), dict):
        irodori_model = deep_merge(irodori_model, existing["irodori-v3"])
    irodori_model["runtime"] = "irodori_direct"
    config["models"] = {"irodori-v3": irodori_model}
    config["defaultModel"] = "irodori-v3"
    config.setdefault("referenceVoicesDir", "./reference/voices")
    return config


def load_config() -> dict[str, Any]:
    merged = copy.deepcopy(DEFAULT_CONFIG)
    for name in ("config.example.json", "config.json", "config.local.json"):
        path = ROOT / name
        if path.exists():
            loaded = load_json(path)
            if not isinstance(loaded, dict):
                raise BridgeError(f"config must be JSON object: {path.name}")
            merged = deep_merge(merged, loaded)
    if os.environ.get("LOCAL_VOICE_PORT"):
        merged["port"] = int(os.environ["LOCAL_VOICE_PORT"])
    if os.environ.get("LOCAL_VOICE_PUBLIC_BASE_URL"):
        merged["publicBaseUrl"] = os.environ["LOCAL_VOICE_PUBLIC_BASE_URL"]
    merged = normalize_config(merged)
    if not merged.get("publicBaseUrl"):
        merged["publicBaseUrl"] = f"http://{merged.get('host', '127.0.0.1')}:{int(merged.get('port', 8717))}"
    return merged


def resolve_path(value: Any) -> Path:
    path = Path(str(value or "")).expanduser()
    return path if path.is_absolute() else (ROOT / path).resolve()


def output_dir(config: dict[str, Any]) -> Path:
    return resolve_path(config.get("audioOutputDir", "./runtime/audio"))


def reference_voices_dir(config: dict[str, Any]) -> Path:
    return resolve_path(config.get("referenceVoicesDir", "./reference/voices"))


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def request_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    raw = handler.rfile.read(length) if length > 0 else b"{}"
    parsed = json.loads(raw.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise BridgeError("request JSON must be object")
    return parsed


def normalize_desktop_pet_id(value: Any) -> str:
    pet_id = str(value or "").strip().lower()
    if not pet_id or pet_id in {"none", ".", ".."} or "/" in pet_id or "\\" in pet_id:
        return "placeholder"
    return pet_id


def desktop_pet_list(pet_root: Path | None = None) -> list[dict[str, str]]:
    root = Path(pet_root) if pet_root is not None else DESKTOP_PET_ROOT
    return [
        {"id": choice.selection_id, "label": choice.display_name}
        for choice in discover_available_pets(root)
    ]


def desktop_pet_settings_path() -> Path:
    override = str(os.environ.get("LOCAL_VOICE_DESKTOP_PET_SETTINGS") or "").strip()
    return Path(override).expanduser().resolve() if override else DESKTOP_PET_SETTINGS_PATH


def load_desktop_pet_settings(path: Path | None = None) -> dict[str, Any]:
    target = Path(path) if path is not None else desktop_pet_settings_path()
    try:
        value = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def update_desktop_pet_settings(value: Any, path: Path | None = None) -> dict[str, Any]:
    target = Path(path) if path is not None else desktop_pet_settings_path()
    with DESKTOP_PET_SETTINGS_LOCK:
        settings = load_desktop_pet_settings(target)
        settings.setdefault("version", 1)
        settings["selectedPetId"] = normalize_desktop_pet_id(value)
        settings["visible"] = True
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
        return settings


def sanitize_text(value: Any) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise BridgeError("text is required")
    if len(text) > 1600:
        raise BridgeError("text is too long")
    return text


def model_config(config: dict[str, Any], model: str) -> dict[str, Any]:
    item = config.get("models", {}).get(model)
    return item if isinstance(item, dict) else {}


def model_list(config: dict[str, Any]) -> list[dict[str, str]]:
    models = config.get("models") if isinstance(config.get("models"), dict) else {}
    return [{"id": str(k), "label": str(v.get("label") or k), "runtime": str(v.get("runtime") or "")} for k, v in models.items() if isinstance(v, dict)]


def find_text_file(folder: Path) -> Path | None:
    for name in TEXT_FILES:
        path = folder / name
        if path.is_file():
            return path
    return None


def scan_reference_voices(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    base = reference_voices_dir(config)
    if base.is_dir():
        for folder in sorted([p for p in base.iterdir() if p.is_dir()]):
            voice_wav = folder / "voice.wav"
            if not voice_wav.is_file():
                continue
            text_file = find_text_file(folder)
            result[folder.name] = {
                "label": folder.name,
                "referenceAudioPath": str(voice_wav),
                "referenceTextPath": str(text_file) if text_file else "",
                "language": "Japanese",
                "source": "reference/voices",
            }
    configured = config.get("referenceVoices") if isinstance(config.get("referenceVoices"), dict) else {}
    for key, value in configured.items():
        if isinstance(value, dict):
            result[str(key)] = value
    return result


def reference_voice_list(config: dict[str, Any]) -> list[dict[str, str]]:
    voices = scan_reference_voices(config)
    return [{"id": "", "label": "none"}] + [{"id": str(k), "label": str(v.get("label") or k)} for k, v in voices.items()]


def normalize_reference_id(value: Any) -> str:
    voice_id = str(value or "").strip()
    if voice_id.lower() in {"none", "qwen3", "qwen"}:
        return ""
    return voice_id


class Handler(BaseHTTPRequestHandler):
    server_version = "LocalVoiceBridge/1.0"

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/v1/control-panel":
            try:
                payload = CONTROL_STATE.snapshot()
                payload["referenceVoices"] = reference_voice_list(load_config())
                json_response(self, HTTPStatus.OK, payload)
            except Exception as exc:
                json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})
            return
        if parsed.path == "/v1/control-panel/poll":
            try:
                values = parse_qs(parsed.query).get("after", ["0"])
                after_id = int(values[0] or 0)
                json_response(self, HTTPStatus.OK, CONTROL_STATE.poll(after_id))
            except (TypeError, ValueError) as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return
        if parsed.path == "/v1/desktop-pet":
            try:
                settings = load_desktop_pet_settings()
                json_response(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "selectedPetId": normalize_desktop_pet_id(settings.get("selectedPetId")),
                        "visible": True,
                        "pets": desktop_pet_list(),
                    },
                )
            except Exception as exc:
                json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})
            return
        try:
            config = load_config()
            if parsed.path == "/health":
                payload = {
                    "ok": True,
                    "engine": "irodori_direct",
                    "runtime": "irodori_direct",
                    "defaultModel": "irodori-v3",
                    "models": model_list(config),
                    "referenceVoices": reference_voice_list(config),
                    "availableVoiceProfiles": model_list(config),
                    "availableReferenceVoices": reference_voice_list(config),
                    "audioOutputDir": "local-api/runtime/audio",
                    "cacheHint": cache_hint(),
                    "pathsExposed": False,
                }
                json_response(self, HTTPStatus.OK, payload)
                return
            if parsed.path == "/v1/models":
                json_response(self, HTTPStatus.OK, {"ok": True, "models": model_list(config)})
                return
            if parsed.path == "/v1/reference-voices":
                json_response(self, HTTPStatus.OK, {"ok": True, "voices": reference_voice_list(config)})
                return
            if parsed.path.startswith("/audio/"):
                self.serve_audio(config, parsed.path[len("/audio/"):])
                return
            json_response(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
        except Exception as exc:
            json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/v1/control-panel/settings":
            try:
                payload = request_json(self)
                payload["initialized"] = True
                json_response(self, HTTPStatus.OK, CONTROL_STATE.update_settings(payload))
            except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return
        if path == "/v1/control-panel/command":
            try:
                payload = request_json(self)
                command = CONTROL_STATE.enqueue_command(str(payload.get("command") or ""))
                json_response(self, HTTPStatus.OK, {"ok": True, "command": command})
            except (json.JSONDecodeError, ValueError) as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return
        if path == "/v1/control-panel/state":
            try:
                payload = request_json(self)
                extension = CONTROL_STATE.update_extension_state(payload)
                json_response(self, HTTPStatus.OK, {"ok": True, "extension": extension})
            except (json.JSONDecodeError, ValueError) as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return
        if path == "/v1/conversation/state":
            try:
                payload = request_json(self)
                json_response(self, HTTPStatus.OK, CONTROL_STATE.update_conversation_state(payload))
            except (json.JSONDecodeError, ValueError) as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return
        if path == "/v1/conversation/event":
            try:
                payload = request_json(self)
                event = CONTROL_STATE.enqueue_conversation_event(
                    str(payload.get("type") or ""),
                    payload.get("payload") if isinstance(payload.get("payload"), dict) else {},
                )
                json_response(self, HTTPStatus.OK, {"ok": True, "event": event})
            except (json.JSONDecodeError, TypeError, ValueError) as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return
        if path == "/v1/desktop-pet":
            try:
                payload = request_json(self)
                settings = update_desktop_pet_settings(payload.get("petId"))
                json_response(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "selectedPetId": settings["selectedPetId"],
                        "visible": True,
                    },
                )
            except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
                json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return
        if path != "/v1/speak":
            json_response(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        try:
            config = load_config()
            payload = request_json(self)
            text = sanitize_text(payload.get("text"))
            request_id = str(payload.get("requestId") or "") or None
            model = "irodori-v3"
            voice_id = normalize_reference_id(payload.get("voiceId") or payload.get("referenceVoice") or "")
            voice_prompt = str(payload.get("voicePrompt") or payload.get("instruct") or "").strip()
            runtime_config = copy.deepcopy(config)
            runtime_config["referenceVoices"] = scan_reference_voices(config)
            source_file, used_reference_audio = synthesize_irodori_direct(
                raw_config=runtime_config,
                model_config=model_config(config, model),
                output_dir=output_dir(config),
                text=text,
                request_id=request_id,
                reference_voice=voice_id or None,
                voice_prompt=voice_prompt,
            )
            audio_url = f"{str(config.get('publicBaseUrl')).rstrip('/')}/audio/{source_file.name}"
            json_response(self, HTTPStatus.OK, {"ok": True, "engine": "irodori_direct", "runtime": "irodori_direct", "model": model, "voiceId": voice_id, "voiceProfile": model, "referenceVoice": voice_id, "usedReferenceAudio": used_reference_audio, "requestId": request_id, "audioUrl": audio_url, "textLength": len(text)})
        except (BridgeError, IrodoriError) as exc:
            print(f"[TTS ERROR] {exc}", file=sys.stderr)
            json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
        except Exception as exc:
            print(f"[TTS ERROR] {type(exc).__name__}: {exc}", file=sys.stderr)
            json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

    def serve_audio(self, config: dict[str, Any], name: str) -> None:
        path = output_dir(config) / Path(unquote(name)).name
        if not path.exists() or not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS:
            json_response(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "audio not found"})
            return
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mimetypes.guess_type(str(path))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


def main() -> int:
    try:
        config = load_config()
        output_dir(config).mkdir(parents=True, exist_ok=True)
        reference_voices_dir(config).mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        print(f"[FATAL] {exc}", file=sys.stderr)
        return 2
    host = str(config.get("host", "127.0.0.1"))
    port = int(config.get("port", 8717))
    print(f"Local Voice Bridge listening on http://{host}:{port}")
    print("runtime=irodori_direct")
    print("model=irodori-v3")
    print(f"cacheHint={cache_hint()}")
    httpd = ThreadingHTTPServer((host, port), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
