"""
tests/test-yamnet-inference.py – Automated Test Suite for Genuine YAMNet AI Service
Tests model loading, AudioSet class mapping, audio preprocessing, VAD,
speech vs. footsteps discrimination, temporal smoothing, category thresholds,
critical smoke/glass-break preservation, and JSON HTTP request handling.
"""

import io
import json
import math
import os
import random
import struct
import sys
import threading
import unittest
import urllib.request
import wave
from http.server import HTTPServer

# Add ai-service to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "ai-service")))

import config
import audio_processor
import detector
import main as ai_main


def make_speech_like_waveform(duration_sec: float = 1.0, sr: int = 16000) -> list:
    """
    Generate a voiced speech-like waveform:
    135 Hz fundamental + speech formants (520 Hz, 1300 Hz, 2400 Hz)
    with syllabic amplitude modulation (3.5 Hz) + slight low-frequency room bias.
    """
    n = int(duration_sec * sr)
    samples = []
    for i in range(n):
        t = i / sr
        # Syllabic envelope with brief inter-syllable pauses
        env = 0.55 + 0.45 * math.sin(2 * math.pi * 3.5 * t)
        voiced = (
            0.35 * math.sin(2 * math.pi * 135.0 * t)
            + 0.30 * math.sin(2 * math.pi * 520.0 * t)
            + 0.22 * math.sin(2 * math.pi * 1300.0 * t)
            + 0.12 * math.sin(2 * math.pi * 2400.0 * t)
        )
        # Include slight DC/low rumble that previously misled ZCR rules
        rumble = 0.05 * math.sin(2 * math.pi * 45.0 * t)
        samples.append(max(-0.95, min(0.95, env * voiced * 0.45 + rumble)))
    return samples


def make_footsteps_waveform(duration_sec: float = 1.0, sr: int = 16000) -> list:
    """
    Generate a footsteps-like waveform:
    Two short (~70 ms) damped low-frequency thuds (110-160 Hz) separated by quiet intervals.
    """
    n = int(duration_sec * sr)
    samples = [0.002 * math.sin(2 * math.pi * 60 * i / sr) for i in range(n)]
    rng = random.Random(42)
    step_times = [0.15, 0.65]
    for st in step_times:
        start_idx = int(st * sr)
        burst_len = int(0.08 * sr)
        for j in range(burst_len):
            idx = start_idx + j
            if idx >= n:
                break
            t_local = j / sr
            decay = math.exp(-t_local * 45.0)
            thud = (
                0.70 * math.sin(2 * math.pi * 115.0 * t_local)
                + 0.35 * math.sin(2 * math.pi * 175.0 * t_local)
                + 0.15 * (rng.random() * 2 - 1)
            )
            samples[idx] = max(-0.95, min(0.95, decay * thud * 0.75))
    return samples


def make_smoke_alarm_waveform(duration_sec: float = 1.0, sr: int = 16000) -> list:
    """Generate a resonant ~3100 Hz smoke detector alarm tone."""
    n = int(duration_sec * sr)
    samples = []
    for i in range(n):
        t = i / sr
        # Pulsed 3100 Hz beep
        gate = 1.0 if (t % 0.5) < 0.35 else 0.05
        samples.append(gate * 0.55 * math.sin(2 * math.pi * 3100.0 * t))
    return samples


def make_glass_break_waveform(duration_sec: float = 1.0, sr: int = 16000) -> list:
    """Generate a sharp high-frequency transient glass shatter burst."""
    n = int(duration_sec * sr)
    rng = random.Random(99)
    samples = [0.0] * n
    burst_start = int(0.25 * sr)
    burst_len = int(0.18 * sr)
    for j in range(burst_len):
        idx = burst_start + j
        if idx >= n:
            break
        t_local = j / sr
        decay = math.exp(-t_local * 18.0)
        high_ring = (
            0.40 * math.sin(2 * math.pi * 3800.0 * t_local)
            + 0.35 * math.sin(2 * math.pi * 5400.0 * t_local)
            + 0.45 * (rng.random() * 2 - 1)
        )
        # High-pass emphasize HF noise by subtracting previous sample
        samples[idx] = max(-0.95, min(0.95, decay * high_ring * 0.8))
    return samples


class TestYAMNetInference(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        print("\n========================================================")
        print("Starting EchoTrace Genuine YAMNet Inference Test Suite")
        print("========================================================")
        detector.init_model()

    def setUp(self):
        detector.reset_temporal_state()

    def test_01_class_map_loading(self):
        """Verify AudioSet 521 classes are loaded from official class map."""
        classes = detector.load_class_map()
        self.assertGreaterEqual(len(classes), 521, "Expected at least 521 AudioSet classes")
        self.assertIn("Speech", classes, "Expected 'Speech' in AudioSet class map")
        self.assertIn("Door", classes, "Expected 'Door' in AudioSet class map")
        has_keys = "Keys jangling" in classes or "Keys jingling" in classes
        self.assertTrue(has_keys, "Expected 'Keys jangling' in AudioSet class map")
        print(f"  ✓ test_01_class_map_loading passed ({len(classes)} classes verified)")

    def test_02_model_initialization_and_readiness(self):
        """Verify model is loaded and reports ready or active fallback."""
        status = detector.get_status()
        self.assertIn(status["status"], ("ready", "fallback"))
        if status["is_neural_network"]:
            self.assertEqual(status["model"], "YAMNet")
            self.assertEqual(status["inference_engine"], "yamnet_neural_network")
            self.assertTrue(detector.is_ready())
        else:
            self.assertEqual(status["model"], "Acoustic-Spectral-Fallback")
            self.assertEqual(status["inference_engine"], "acoustic_spectral_fallback")
        print(f"  ✓ test_02_model_initialization_and_readiness passed (engine: {status['inference_engine']})")

    def test_03_audio_processor_wav_decoding(self):
        """Verify WAV parser correctly decodes 16 kHz 16-bit mono audio."""
        num_samples = 16000
        raw_pcm = bytearray()
        for i in range(num_samples):
            val = int(math.sin(2 * math.pi * 440 * i / 16000) * 32700)
            raw_pcm.extend(struct.pack("<h", val))

        wav_io = io.BytesIO()
        with wave.open(wav_io, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(16000)
            wav_file.writeframes(raw_pcm)

        wav_bytes = wav_io.getvalue()
        decoded = audio_processor.decode_audio_payload(wav_bytes, "audio/wav")

        self.assertEqual(len(decoded), 16000)
        self.assertAlmostEqual(max(decoded), 1.0, places=1)
        self.assertAlmostEqual(min(decoded), -1.0, places=1)
        print("  ✓ test_03_audio_processor_wav_decoding passed (16000 samples decoded & normalized)")

    def test_04_audio_processor_stereo_resampling(self):
        """Verify 44.1 kHz stereo audio is averaged to mono and resampled to 16 kHz."""
        orig_sr = 44100
        num_frames = orig_sr // 2
        stereo_pcm = bytearray()
        for i in range(num_frames):
            val_l = int(math.sin(2 * math.pi * 300 * i / orig_sr) * 15000)
            val_r = int(math.sin(2 * math.pi * 300 * i / orig_sr) * 15000)
            stereo_pcm.extend(struct.pack("<hh", val_l, val_r))

        wav_io = io.BytesIO()
        with wave.open(wav_io, "wb") as wav_file:
            wav_file.setnchannels(2)
            wav_file.setsampwidth(2)
            wav_file.setframerate(orig_sr)
            wav_file.writeframes(stereo_pcm)

        decoded = audio_processor.decode_audio_payload(wav_io.getvalue(), "audio/wav")
        self.assertAlmostEqual(len(decoded), 8000, delta=10)
        print(f"  ✓ test_04_audio_processor_stereo_resampling passed (resampled {orig_sr}Hz stereo -> 16kHz mono, len={len(decoded)})")

    def test_05_audio_processor_invalid_inputs(self):
        """Verify graceful handling of corrupted or empty audio."""
        self.assertEqual(audio_processor.decode_audio_payload(b""), [])
        self.assertEqual(audio_processor.decode_audio_payload(b"corrupted garbage bytes here"), [])
        print("  ✓ test_05_audio_processor_invalid_inputs passed")

    def test_06_real_yamnet_inference_execution(self):
        """Verify model classifies 16 kHz audio waveform."""
        samples = [math.sin(i * 0.1) * 0.5 + math.sin(i * 0.02) * 0.3 for i in range(16000)]
        result = detector.classify_waveform(samples, top_k=5)

        self.assertIsNotNone(result)
        self.assertIn(result["inference_engine"], ("yamnet_neural_network", "acoustic_spectral_fallback"))
        self.assertEqual(result["duration"], 1.0)
        self.assertIn("predictions", result)
        self.assertGreaterEqual(len(result["predictions"]), 1)

        top_pred = result["predictions"][0]
        self.assertIn("sound_class", top_pred)
        self.assertIn("confidence", top_pred)
        self.assertGreaterEqual(top_pred["confidence"], 0.0)
        self.assertLessEqual(top_pred["confidence"], 1.0)
        print(f"  ✓ test_06_real_yamnet_inference_execution passed (top class: '{top_pred['sound_class']}', conf: {top_pred['confidence']})")

    def test_07_silence_rejection(self):
        """Verify pure silence returns None or no detection."""
        silent_samples = [0.0] * 16000
        result = detector.classify_waveform(silent_samples)
        if result:
            self.assertIsNone(result.get("sound_class"), "Silence should not trigger target sound match")
        else:
            self.assertIsNone(result)
        print("  ✓ test_07_silence_rejection passed (no false positive target triggers on silence)")

    def test_08_audioset_class_mapping_coverage(self):
        """Verify AudioSet mapping includes Glass, Shatter, Smoke alarm, Walk/footsteps, and Speech."""
        classes = detector.load_class_map()
        index_map = detector._rebuild_index_map(classes)
        mapped_targets = set(index_map.values())

        self.assertIn("Glass breaking", mapped_targets, "Expected Glass/Shatter mapped to 'Glass breaking'")
        self.assertIn("Smoke detector, smoke alarm", mapped_targets)
        self.assertIn("Footsteps", mapped_targets)
        self.assertIn("Speech", mapped_targets)
        self.assertIn("Loud impacts", mapped_targets)
        print(f"  ✓ test_08_audioset_class_mapping_coverage passed ({len(index_map)} AudioSet classes mapped)")

    def test_09_vad_and_speech_not_classified_as_footsteps(self):
        """Verify near-mic voiced speech with modulation & low-freq rumble detects Speech, NEVER Footsteps."""
        speech_wave = make_speech_like_waveform()
        cleaned = audio_processor.preprocess_for_inference(speech_wave, 16000)
        vad = audio_processor.analyze_voice_activity(cleaned, 16000)

        self.assertTrue(vad["is_speech_active"], f"Expected VAD to detect speech (got {vad})")
        self.assertGreaterEqual(vad["speech_probability"], config.VAD_SPEECH_ACTIVE_THRESHOLD)

        result = detector.classify_waveform(speech_wave, client_session_id="test-speech-session")
        self.assertIsNotNone(result)
        self.assertNotEqual(result.get("sound_class"), "Footsteps", "Speech must NEVER be classified as Footsteps")
        self.assertEqual(result.get("sound_class"), "Speech")
        print(f"  ✓ test_09_vad_and_speech_not_classified_as_footsteps passed (VAD prob: {vad['speech_probability']}, class: {result.get('sound_class')})")

    def test_10_temporal_smoothing_and_footsteps_confirmation(self):
        """Verify single isolated Footsteps chunk is held back, while consecutive chunks confirm Footsteps."""
        foot_wave = make_footsteps_waveform()
        sid = "test-footstep-smoothing"

        # Chunk 1: isolated transient footstep should be held pending confirmation
        res1 = detector.classify_waveform(foot_wave, client_session_id=sid)
        self.assertIsNotNone(res1)
        self.assertIsNone(res1.get("sound_class"), "Single isolated Footsteps chunk should require confirmation")

        # Chunk 2: consecutive footstep chunk confirms Footsteps
        res2 = detector.classify_waveform(foot_wave, client_session_id=sid)
        self.assertIsNotNone(res2)
        self.assertEqual(res2.get("sound_class"), "Footsteps")
        print("  ✓ test_10_temporal_smoothing_and_footsteps_confirmation passed")

    def test_11_critical_smoke_and_glass_break_immediate_detection(self):
        """Verify Smoke detector and Glass breaking trigger immediately without multi-chunk delay."""
        smoke_wave = make_smoke_alarm_waveform()
        smoke_res = detector.classify_waveform(smoke_wave, client_session_id="test-smoke")
        self.assertIsNotNone(smoke_res)
        self.assertEqual(smoke_res.get("sound_class"), "Smoke detector, smoke alarm")
        self.assertFalse(smoke_res.get("smoothed", True), "Critical smoke alarm must bypass smoothing delay")

        glass_wave = make_glass_break_waveform()
        glass_res = detector.classify_waveform(glass_wave, client_session_id="test-glass")
        self.assertIsNotNone(glass_res)
        self.assertEqual(glass_res.get("sound_class"), "Glass breaking")
        self.assertFalse(glass_res.get("smoothed", True), "Critical glass breaking must bypass smoothing delay")
        print("  ✓ test_11_critical_smoke_and_glass_break_immediate_detection passed")

    def test_12_category_specific_thresholds_and_vad_override(self):
        """Verify category thresholds give Footsteps a stricter bar than Speech and Critical sounds."""
        t_smoke = detector.get_effective_threshold("Smoke detector, smoke alarm", 0.40)
        t_speech = detector.get_effective_threshold("Speech", 0.40)
        t_foot = detector.get_effective_threshold("Footsteps", 0.40)

        self.assertLess(t_smoke, t_foot)
        self.assertLess(t_speech, t_foot)
        self.assertGreaterEqual(t_foot, 0.50)

        # Verify smoother suppresses Footsteps when VAD says active speech
        smoother = detector.TemporalPredictionSmoother()
        vad_speech = {
            "is_speech_active": True,
            "speech_probability": 0.85,
            "voiced_frame_ratio": 0.70,
            "low_band_ratio": 0.15,
            "speech_band_ratio": 0.75,
        }
        chosen, conf, _ema, _sm = smoother.evaluate(
            session_id="vad-override",
            raw_target_scores={"Footsteps": 0.62, "Speech": 0.55},
            vad_info=vad_speech,
        )
        self.assertEqual(chosen, "Speech", f"Expected Speech override when VAD active, got {chosen} ({conf})")
        print(f"  ✓ test_12_category_specific_thresholds_and_vad_override passed (smoke={t_smoke}, speech={t_speech}, footsteps={t_foot})")

    def test_13_http_json_samples_endpoint(self):
        """Verify ai-service HTTP /classify endpoint handles JSON 'samples' without NameError."""
        server = HTTPServer(("127.0.0.1", 0), ai_main.AIServiceHandler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            speech_wave = make_speech_like_waveform(0.5, 16000)
            payload = json.dumps({
                "samples": speech_wave,
                "sample_rate": 16000,
                "clientSessionId": "http-test-session",
                "confidence_threshold": 0.40,
            }).encode("utf-8")

            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/classify",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                self.assertEqual(resp.status, 200)
                data = json.loads(resp.read().decode("utf-8"))
                self.assertTrue(data.get("detected"))
                self.assertEqual(data.get("sound_class"), "Speech")
                self.assertEqual(data.get("client_session_id"), "http-test-session")
            print("  ✓ test_13_http_json_samples_endpoint passed")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
