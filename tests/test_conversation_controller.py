from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
LOCAL_API = ROOT / "local-api"
if str(LOCAL_API) not in sys.path:
    sys.path.insert(0, str(LOCAL_API))

from conversation_controller import (  # noqa: E402
    VK_LCONTROL,
    VK_OEM_102,
    VK_RCONTROL,
    VoiceConversationController,
)


class InlineExecutor:
    def submit(self, function, *args):
        function(*args)
        return None

    def shutdown(self, **_kwargs):
        return None


class DelayedExecutor:
    def __init__(self) -> None:
        self.items = []

    def submit(self, function, *args):
        self.items.append((function, args))
        return None

    def run_all(self) -> None:
        while self.items:
            function, args = self.items.pop(0)
            function(*args)

    def shutdown(self, **_kwargs):
        self.items.clear()


class FakeClient:
    def __init__(self) -> None:
        self.commands: list[str] = []
        self.events: list[tuple[str, dict[str, object]]] = []
        self.states: list[dict[str, object]] = []
        self.playing_states: list[bool] = []

    def get_snapshot(self):
        playing = self.playing_states.pop(0) if self.playing_states else False
        return {"extension": {"isPlaying": playing, "playbackPhase": "playing" if playing else "idle"}}

    def send_command(self, command):
        self.commands.append(command)
        return {"ok": True}

    def send_conversation_event(self, event_type, payload):
        self.events.append((event_type, dict(payload)))
        return {"ok": True}

    def update_conversation_state(self, payload):
        self.states.append(dict(payload))
        return {"ok": True}


class FakeRecorder:
    sample_rate = 16000

    def __init__(self, samples: np.ndarray | None = None) -> None:
        self.samples = samples if samples is not None else np.full(16000, 0.02, dtype=np.float32)
        self.started = 0
        self.stopped = 0
        self.discarded = 0

    def start(self):
        self.started += 1

    def stop(self):
        self.stopped += 1
        return self.samples.copy()

    def discard(self):
        self.discarded += 1


class FakeTranscriber:
    def __init__(self, text: str = "日本語のテストです") -> None:
        self.text = text
        self.calls = 0
        self.prepared: list[str] = []

    def prepare(self, model_name):
        self.prepared.append(str(model_name))
        return "cuda"

    def transcribe(self, _audio, _model):
        self.calls += 1
        return self.text, "cuda"


class FailingPrepareTranscriber(FakeTranscriber):
    def prepare(self, model_name):
        self.prepared.append(str(model_name))
        raise RuntimeError("model download failed")


class VoiceConversationControllerTests(unittest.TestCase):
    def make_controller(self, *, samples=None, text="日本語のテストです", control_executor=None, stt_executor=None):
        client = FakeClient()
        recorder = FakeRecorder(samples)
        transcriber = FakeTranscriber(text)
        controller = VoiceConversationController(
            client,
            recorder=recorder,
            transcriber=transcriber,
            control_executor=control_executor or InlineExecutor(),
            executor=stt_executor or InlineExecutor(),
            sleep=lambda _seconds: None,
        )
        controller.configure(enabled=True, stt_model="small", cancel_grace_ms=700)
        return controller, client, recorder, transcriber

    def test_model_is_prepared_when_enabled_or_changed_not_on_first_utterance(self):
        controller, _client, _recorder, transcriber = self.make_controller()
        self.assertEqual(transcriber.prepared, ["small"])
        controller.configure(enabled=True, stt_model="medium", cancel_grace_ms=700)
        self.assertEqual(transcriber.prepared, ["small", "medium"])

    def test_failed_model_prepare_is_not_retried_on_every_settings_poll(self):
        client = FakeClient()
        transcriber = FailingPrepareTranscriber()
        controller = VoiceConversationController(
            client,
            recorder=FakeRecorder(),
            transcriber=transcriber,
            control_executor=InlineExecutor(),
            executor=InlineExecutor(),
            sleep=lambda _seconds: None,
        )
        controller.configure(enabled=True, stt_model="small", cancel_grace_ms=700)
        controller.configure(enabled=True, stt_model="small", cancel_grace_ms=700)
        self.assertEqual(transcriber.prepared, ["small"])
        self.assertEqual(client.states[-1]["phase"], "error")

        controller.configure(enabled=False, stt_model="small", cancel_grace_ms=700)
        controller.configure(enabled=True, stt_model="small", cancel_grace_ms=700)
        self.assertEqual(transcriber.prepared, ["small", "small"])

    def test_idle_state_is_reconciled_after_browser_reports_stale_hotkey_text(self):
        controller, client, _recorder, _transcriber = self.make_controller()
        controller.reconcile_reported_state({
            "phase": "idle",
            "statusText": "待機中（右Ctrl長押し）",
            "sttDevice": "",
            "sttModel": "small",
        })
        self.assertEqual(client.states[-1]["statusText"], "待機中（右Ctrl＋＼ 長押し）")
        self.assertEqual(client.states[-1]["sttDevice"], "cuda")

    def press_chord(self, controller):
        self.assertFalse(controller.handle_key_event(VK_RCONTROL, True))
        self.assertTrue(controller.handle_key_event(VK_OEM_102, True))

    def release_chord(self, controller):
        self.assertTrue(controller.handle_key_event(VK_OEM_102, False))
        self.assertFalse(controller.handle_key_event(VK_RCONTROL, False))

    def test_right_ctrl_plus_oem_102_starts_recording_after_stop_and_cancel(self):
        controller, client, recorder, _ = self.make_controller()
        self.press_chord(controller)
        self.assertEqual(client.commands, ["stop"])
        self.assertEqual(client.events[0][0], "cancel_pending")
        self.assertEqual(recorder.started, 1)
        self.assertEqual(client.states[-1]["phase"], "recording")

    def test_left_ctrl_does_not_start_recording(self):
        controller, client, recorder, _ = self.make_controller()
        self.assertFalse(controller.handle_key_event(VK_LCONTROL, True))
        self.assertEqual(client.commands, [])
        self.assertEqual(recorder.started, 0)

    def test_right_ctrl_alone_does_not_start_or_get_suppressed(self):
        controller, client, recorder, _ = self.make_controller()
        self.assertFalse(controller.handle_key_event(VK_RCONTROL, True))
        self.assertFalse(controller.handle_key_event(VK_RCONTROL, False))
        self.assertEqual(client.commands, [])
        self.assertEqual(recorder.started, 0)

    def test_oem_102_alone_does_not_start_or_get_suppressed(self):
        controller, client, recorder, _ = self.make_controller()
        self.assertFalse(controller.handle_key_event(VK_OEM_102, True))
        self.assertFalse(controller.handle_key_event(VK_OEM_102, False))
        self.assertEqual(client.commands, [])
        self.assertEqual(recorder.started, 0)

    def test_key_repeat_does_not_start_twice(self):
        controller, _client, recorder, _ = self.make_controller()
        self.press_chord(controller)
        self.assertTrue(controller.handle_key_event(VK_OEM_102, True))
        self.assertEqual(recorder.started, 1)

    def test_release_transcribes_and_emits_one_transcript(self):
        controller, client, recorder, transcriber = self.make_controller()
        self.press_chord(controller)
        self.release_chord(controller)
        self.assertEqual(recorder.stopped, 1)
        self.assertEqual(transcriber.calls, 1)
        transcripts = [item for item in client.events if item[0] == "transcript"]
        self.assertEqual(len(transcripts), 1)
        self.assertEqual(transcripts[0][1]["cancelGraceMs"], 700)

    def test_empty_transcript_is_not_emitted(self):
        controller, client, _recorder, _ = self.make_controller(text="   ")
        self.press_chord(controller)
        self.release_chord(controller)
        self.assertFalse(any(event_type == "transcript" for event_type, _payload in client.events))

    def test_short_or_silent_audio_is_not_transcribed(self):
        samples = np.zeros(1000, dtype=np.float32)
        controller, client, _recorder, transcriber = self.make_controller(samples=samples)
        self.press_chord(controller)
        self.release_chord(controller)
        self.assertEqual(transcriber.calls, 0)
        self.assertFalse(any(event_type == "transcript" for event_type, _payload in client.events))

    def test_disabled_mode_does_not_capture_right_ctrl(self):
        controller, client, recorder, _ = self.make_controller()
        controller.configure(enabled=False, stt_model="small", cancel_grace_ms=700)
        self.assertFalse(controller.handle_key_event(VK_RCONTROL, True))
        self.assertFalse(controller.handle_key_event(VK_OEM_102, True))
        self.assertEqual(recorder.started, 0)
        self.assertEqual(client.states[-1]["phase"], "off")

    def test_hook_callback_schedules_work_off_callback_thread(self):
        delayed = DelayedExecutor()
        controller, client, recorder, _ = self.make_controller(control_executor=delayed)
        self.press_chord(controller)
        self.assertEqual(client.commands, [])
        self.assertEqual(recorder.started, 0)
        delayed.run_all()
        self.assertEqual(client.commands, ["stop"])
        self.assertEqual(recorder.started, 1)


if __name__ == "__main__":
    unittest.main()
