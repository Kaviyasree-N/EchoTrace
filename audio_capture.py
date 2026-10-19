"""
audio_capture.py – Background microphone capture thread for EchoTrace.
"""

from __future__ import annotations

import datetime
import logging
import threading
import time
from collections import deque
from typing import Any, Deque, Dict, Optional

import numpy as np
import sounddevice as sd

from config import CHUNK_DURATION, SAMPLE_RATE
import database
import detector

logger = logging.getLogger(__name__)

BUFFER_SIZE = 50


class AudioCapture:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._room: str = "Living Room"
        self._running: bool = False
        self._thread: Optional[threading.Thread] = None
        self._events_buffer: Deque[Dict[str, Any]] = deque(maxlen=BUFFER_SIZE)
        self._session_counts: Dict[str, int] = {}
        self._last_error: Optional[str] = None

    # ── Control ───────────────────────────────────────────────────────────────
    def start(self) -> None:
        with self._lock:
            if self._running:
                return
            self._running = True
            self._last_error = None
        self._thread = threading.Thread(
            target=self._capture_loop, daemon=True, name="EchoTrace-Audio"
        )
        self._thread.start()
        logger.info("AudioCapture started.")

    def stop(self) -> None:
        with self._lock:
            self._running = False
        logger.info("AudioCapture stopped.")

    def is_running(self) -> bool:
        with self._lock:
            return self._running

    def set_room(self, room: str) -> None:
        with self._lock:
            self._room = room

    def get_room(self) -> str:
        with self._lock:
            return self._room

    def get_last_error(self) -> Optional[str]:
        with self._lock:
            return self._last_error

    # ── Read ──────────────────────────────────────────────────────────────────
    def get_recent_events(self, n: int = 8) -> list:
        with self._lock:
            items = list(self._events_buffer)
        return items[-n:][::-1]  # newest first

    def get_session_counts(self) -> Dict[str, int]:
        with self._lock:
            return dict(self._session_counts)

    # ── Loop ──────────────────────────────────────────────────────────────────
    def _capture_loop(self) -> None:
        logger.info("Capture loop started (rate=%d, chunk=%ds).", SAMPLE_RATE, CHUNK_DURATION)

        # Verify microphone is available before entering the main loop
        try:
            test = sd.rec(
                frames=int(SAMPLE_RATE * 0.1),
                samplerate=SAMPLE_RATE,
                channels=1,
                dtype="float32",
                blocking=True,
            )
            logger.info("Microphone test passed, shape=%s", test.shape)
        except Exception as exc:
            err = f"Microphone not accessible: {exc}"
            logger.error(err)
            with self._lock:
                self._last_error = err
                self._running = False
            return

        while True:
            with self._lock:
                if not self._running:
                    break
                current_room = self._room

            # Record one chunk
            try:
                waveform = sd.rec(
                    frames=SAMPLE_RATE * CHUNK_DURATION,
                    samplerate=SAMPLE_RATE,
                    channels=1,
                    dtype="float32",
                    blocking=True,
                )
            except Exception as exc:
                err = f"Recording error: {exc}"
                logger.error(err)
                with self._lock:
                    self._last_error = err
                time.sleep(1)
                continue

            waveform_1d = waveform.flatten()

            if not detector.is_model_ready():
                logger.debug("Model not ready, skipping chunk.")
                time.sleep(0.5)
                continue

            result = detector.process_audio(waveform_1d)
            if result is None:
                continue

            sound_class, confidence = result

            # Persist to DB
            try:
                database.insert_event(
                    sound_class=sound_class,
                    confidence=confidence,
                    room=current_room,
                )
            except Exception as exc:
                logger.error("DB insert error: %s", exc)

            # Update in-memory buffer
            event = {
                "timestamp": datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z",
                "room": current_room,
                "sound_class": sound_class,
                "confidence": round(confidence, 3),
            }
            with self._lock:
                self._events_buffer.append(event)
                self._session_counts[sound_class] = (
                    self._session_counts.get(sound_class, 0) + 1
                )
                self._last_error = None  # clear any previous error on success

            logger.info("[%s] %s (%.1f%%) in '%s'",
                        event["timestamp"], sound_class,
                        confidence * 100, current_room)

        logger.info("Capture loop ended.")


# ── Singleton ─────────────────────────────────────────────────────────────────
_capture_instance: Optional[AudioCapture] = None
_instance_lock = threading.Lock()


def get_capture_instance() -> AudioCapture:
    global _capture_instance
    with _instance_lock:
        if _capture_instance is None:
            _capture_instance = AudioCapture()
    return _capture_instance
