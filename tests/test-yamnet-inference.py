"""
tests/test-yamnet-inference.py – Automated Test Suite for Genuine YAMNet AI Service
Tests model loading, AudioSet class mapping, audio preprocessing,
real neural inference, confidence calibration, and error resilience.
"""

import io
import math
import os
import struct
import sys
import unittest
import wave

# Add ai-service to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "ai-service")))

import config
import audio_processor
import detector


class TestYAMNetInference(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        print("\n========================================================")
        print("Starting EchoTrace Genuine YAMNet Inference Test Suite")
        print("========================================================")
        detector.init_model()

    def test_01_class_map_loading(self):
        """Verify AudioSet 521 classes are loaded from official class map."""
        classes = detector.load_class_map()
        self.assertGreaterEqual(len(classes), 521, "Expected at least 521 AudioSet classes")
        self.assertIn("Speech", classes, "Expected 'Speech' in AudioSet class map")
        self.assertIn("Door", classes, "Expected 'Door' in AudioSet class map")
        # In AudioSet, the official display name is 'Keys jangling'
        has_keys = "Keys jangling" in classes or "Keys jingling" in classes
        self.assertTrue(has_keys, "Expected 'Keys jangling' in AudioSet class map")
        print(f"  ✓ test_01_class_map_loading passed ({len(classes)} classes verified)")

    def test_02_model_initialization_and_readiness(self):
        """Verify genuine YAMNet model is loaded and reports ready."""
        status = detector.get_status()
        self.assertEqual(status["status"], "ready")
        self.assertTrue(status["is_neural_network"], "Expected genuine neural network to be active")
        self.assertEqual(status["model"], "YAMNet")
        self.assertEqual(status["inference_engine"], "yamnet_neural_network")
        self.assertTrue(detector.is_ready())
        print(f"  ✓ test_02_model_initialization_and_readiness passed (engine: {status['inference_engine']})")

    def test_03_audio_processor_wav_decoding(self):
        """Verify WAV parser correctly decodes 16 kHz 16-bit mono audio."""
        num_samples = 16000  # 1 second
        raw_pcm = bytearray()
        for i in range(num_samples):
            # 440 Hz sine wave with full scale 32700 amplitude
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
        num_frames = orig_sr // 2  # 0.5 second
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
        # 0.5s at 16000Hz should be ~8000 samples
        self.assertAlmostEqual(len(decoded), 8000, delta=10)
        print(f"  ✓ test_04_audio_processor_stereo_resampling passed (resampled {orig_sr}Hz stereo -> 16kHz mono, len={len(decoded)})")

    def test_05_audio_processor_invalid_inputs(self):
        """Verify graceful handling of corrupted or empty audio."""
        self.assertEqual(audio_processor.decode_audio_payload(b""), [])
        self.assertEqual(audio_processor.decode_audio_payload(b"corrupted garbage bytes here"), [])
        print("  ✓ test_05_audio_processor_invalid_inputs passed")

    def test_06_real_yamnet_inference_execution(self):
        """Verify genuine YAMNet model classifies 16 kHz audio waveform."""
        # 1.0s synthetic audio waveform with broadband frequency content
        samples = [math.sin(i * 0.1) * 0.5 + math.sin(i * 0.02) * 0.3 for i in range(16000)]
        result = detector.classify_waveform(samples, top_k=5)

        self.assertIsNotNone(result)
        self.assertEqual(result["inference_engine"], "yamnet_neural_network")
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
        # In YAMNet, silence either has no matching target classes above threshold or is rejected
        if result:
            self.assertIsNone(result.get("sound_class"), "Silence should not trigger target sound match")
        else:
            self.assertIsNone(result)
        print("  ✓ test_07_silence_rejection passed (no false positive target triggers on silence)")


if __name__ == "__main__":
    unittest.main()
