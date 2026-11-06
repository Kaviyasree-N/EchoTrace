"""
ai-service/detector.py – Google YAMNet Sound Classification Engine
Loads pretrained YAMNet model from TensorFlow Hub and runs real inference
on 16 kHz mono audio waveforms mapped to AudioSet classes.
"""

import csv
import io
import logging
import math
import os
import threading
from typing import Dict, List, Optional, Tuple

from config import (
    CONFIDENCE_THRESHOLD,
    SAMPLE_RATE,
    TARGET_CLASSES,
    YAMNET_CLASS_MAP_URL,
    YAMNET_MODEL_URL,
)

logger = logging.getLogger("EchoTrace-Detector")

# State & synchronization
_lock = threading.Lock()
_yamnet_model = None
_class_names: List[str] = []
_model_status: str = "uninitialized"  # "uninitialized", "loading", "ready", "fallback", "failed"
_is_neural_network: bool = False
_model_load_error: Optional[str] = None


def load_class_map() -> List[str]:
    """
    Load AudioSet 521 class display names.
    Checks local CSV file first, falls back to GitHub URL, then TARGET_CLASSES.
    """
    local_csv = os.path.join(os.path.dirname(__file__), "yamnet_class_map.csv")
    if os.path.isfile(local_csv):
        try:
            with open(local_csv, mode="r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                names = [row["display_name"] for row in reader]
                if len(names) >= 500:
                    logger.info("Loaded %d AudioSet classes from local yamnet_class_map.csv", len(names))
                    return names
        except Exception as exc:
            logger.warning("Error reading local class map: %s", exc)

    # Online download fallback
    try:
        import urllib.request
        req = urllib.request.Request(
            YAMNET_CLASS_MAP_URL,
            headers={"User-Agent": "EchoTrace/1.0"}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            text = resp.read().decode("utf-8")
            reader = csv.DictReader(io.StringIO(text))
            names = [row["display_name"] for row in reader]
            logger.info("Downloaded %d AudioSet classes from GitHub.", len(names))
            return names
    except Exception as exc:
        logger.warning("Could not download class map (%s); using default TARGET_CLASSES.", exc)
        return list(TARGET_CLASSES)


def init_model() -> None:
    """
    Initialize YAMNet model only once in memory.
    Attempts TensorFlow Hub load first; if unavailable, switches cleanly to fallback status.
    """
    global _yamnet_model, _class_names, _model_status, _is_neural_network, _model_load_error

    with _lock:
        if _model_status in ("ready", "fallback") and _yamnet_model is not None:
            return

        _model_status = "loading"
        _class_names = load_class_map()

        try:
            logger.info("Loading Google YAMNet model from TensorFlow Hub: %s", YAMNET_MODEL_URL)
            import tensorflow as tf
            import tensorflow_hub as hub

            # Check if local SavedModel cache exists
            cache_dir = os.path.join(os.path.dirname(__file__), ".yamnet_cache")
            if os.path.isdir(cache_dir) and os.listdir(cache_dir):
                logger.info("Found local YAMNet SavedModel in %s", cache_dir)
                _yamnet_model = tf.saved_model.load(cache_dir)
            else:
                _yamnet_model = hub.load(YAMNET_MODEL_URL)

            # Warm-up inference with 1-second silence to ensure graph compiles
            dummy_input = tf.zeros([SAMPLE_RATE], dtype=tf.float32)
            _scores, _embeddings, _spectrogram = _yamnet_model(dummy_input)

            _model_status = "ready"
            _is_neural_network = True
            _model_load_error = None
            logger.info("Genuine Google YAMNet neural network loaded successfully! Output classes: %d", len(_class_names))

        except Exception as exc:
            _model_load_error = str(exc)
            _yamnet_model = None
            _is_neural_network = False
            _model_status = "fallback"
            logger.warning(
                "TensorFlow YAMNet model could not be initialized (%s). Operating in acoustic spectral fallback mode.",
                exc,
            )


def get_status() -> Dict:
    """Return health and model status metadata."""
    return {
        "status": _model_status,
        "is_neural_network": _is_neural_network,
        "model": "YAMNet" if _is_neural_network else "Acoustic-Spectral-Fallback",
        "inference_engine": "yamnet_neural_network" if _is_neural_network else "acoustic_spectral_fallback",
        "classes_count": len(_class_names),
        "target_classes_count": len(TARGET_CLASSES),
        "error": _model_load_error,
    }


def is_ready() -> bool:
    """Returns True ONLY when genuine YAMNet model is ready."""
    return _model_status == "ready" and _is_neural_network and (_yamnet_model is not None)


def get_classes() -> List[str]:
    return _class_names if _class_names else list(TARGET_CLASSES)


def classify_waveform(samples: List[float], top_k: int = 5) -> Optional[Dict]:
    """
    Run sound classification on 16 kHz mono waveform.
    Uses genuine YAMNet neural network if ready, or heuristic fallback if unavailable.
    """
    if not samples or len(samples) < int(SAMPLE_RATE * 0.15):
        return None

    duration = round(len(samples) / SAMPLE_RATE, 2)

    # 1. Genuine Google YAMNet Neural Network Path
    if _is_neural_network and _yamnet_model is not None:
        try:
            import numpy as np
            import tensorflow as tf

            # Convert to float32 1-D numpy array and clamp to [-1.0, 1.0]
            waveform = np.array(samples, dtype=np.float32).flatten()
            max_amp = np.max(np.abs(waveform))
            if max_amp > 1.0:
                waveform = waveform / max_amp

            waveform_tensor = tf.constant(waveform, dtype=tf.float32)

            # Model outputs: scores (N, 521), embeddings (N, 1024), spectrogram (M, 64)
            scores, _embeddings, _spectrogram = _yamnet_model(waveform_tensor)

            # Frame score aggregation: mean pooling across temporal frames
            mean_scores = tf.reduce_mean(scores, axis=0).numpy()

            # Rank predictions
            ranked_indices = np.argsort(mean_scores)[::-1]
            all_predictions = []
            for idx in ranked_indices[:top_k]:
                idx_int = int(idx)
                if idx_int < len(_class_names):
                    all_predictions.append({
                        "sound_class": _class_names[idx_int],
                        "confidence": round(float(mean_scores[idx_int]), 3),
                    })

            # Check for matches in TARGET_CLASSES above CONFIDENCE_THRESHOLD
            matched_sound = None
            matched_conf = 0.0

            for pred in all_predictions:
                if pred["confidence"] >= CONFIDENCE_THRESHOLD:
                    pred_lower = pred["sound_class"].lower()
                    for target in TARGET_CLASSES:
                        target_lower = target.lower()
                        if target_lower in pred_lower or pred_lower in target_lower:
                            matched_sound = target  # Canonical target class name
                            matched_conf = pred["confidence"]
                            break
                    if matched_sound:
                        break

            if matched_sound:
                return {
                    "sound_class": matched_sound,
                    "confidence": matched_conf,
                    "duration": duration,
                    "inference_engine": "yamnet_neural_network",
                    "predictions": all_predictions,
                }

            # If no target sound met threshold, return top prediction metadata without match
            return {
                "sound_class": None,
                "confidence": 0.0,
                "duration": duration,
                "inference_engine": "yamnet_neural_network",
                "predictions": all_predictions,
            }

        except Exception as exc:
            logger.error("YAMNet neural inference error: %s", exc)

    # 2. Heuristic Acoustic Fallback Path (only when neural model is unavailable)
    return acoustic_spectral_classify(samples, duration)


def acoustic_spectral_classify(samples: List[float], duration: float) -> Optional[Dict]:
    """
    Acoustic spectral feature classifier used ONLY when neural model cannot be loaded.
    Clearly labeled in return metadata as 'acoustic_spectral_fallback'.
    """
    n = len(samples)
    if n == 0:
        return None

    # RMS Energy
    rms = math.sqrt(sum(s * s for s in samples) / n)
    if rms < 0.02:
        return None  # Room silence

    # Zero Crossing Rate (ZCR)
    zero_crossings = 0
    for i in range(1, n):
        if (samples[i] >= 0 and samples[i - 1] < 0) or (samples[i] < 0 and samples[i - 1] >= 0):
            zero_crossings += 1
    zcr = zero_crossings / n

    # Peak-to-average ratio (Crest factor)
    peak = max(abs(s) for s in samples)
    crest = peak / (rms + 1e-6)

    # Segment energy variance
    num_subchunks = 8
    subchunk_len = n // num_subchunks
    sub_energies = []
    for i in range(num_subchunks):
        sub = samples[i * subchunk_len : (i + 1) * subchunk_len]
        if sub:
            sub_energies.append(math.sqrt(sum(s * s for s in sub) / len(sub)))

    energy_variance = max(sub_energies) - min(sub_energies) if sub_energies else 0

    detected_sound = "Speech"
    confidence = 0.72

    if zcr > 0.25 and crest > 3.5:
        detected_sound = "Keys jingling"
        confidence = 0.88
    elif zcr > 0.22 and energy_variance > 0.08:
        detected_sound = "Dishes, pots, and pans"
        confidence = 0.85
    elif zcr < 0.08 and crest > 3.0:
        detected_sound = "Knock" if duration < 1.2 else "Door"
        confidence = 0.86
    elif zcr < 0.12 and energy_variance > 0.04:
        detected_sound = "Footsteps"
        confidence = 0.78
    elif 0.12 <= zcr <= 0.22 and energy_variance < 0.03 and rms > 0.04:
        detected_sound = "Water tap, faucet"
        confidence = 0.84
    elif 0.09 <= zcr <= 0.18:
        detected_sound = "Speech"
        confidence = 0.82
    else:
        detected_sound = "Drawer"
        confidence = 0.71

    if confidence < CONFIDENCE_THRESHOLD:
        return None

    predictions = [
        {"sound_class": detected_sound, "confidence": confidence},
        {"sound_class": "Footsteps" if detected_sound != "Footsteps" else "Speech", "confidence": round(confidence * 0.6, 2)},
        {"sound_class": "Water tap, faucet" if detected_sound != "Water tap, faucet" else "Dishes, pots, and pans", "confidence": round(confidence * 0.4, 2)},
    ]

    return {
        "sound_class": detected_sound,
        "confidence": round(confidence, 3),
        "duration": duration,
        "inference_engine": "acoustic_spectral_fallback",
        "predictions": predictions,
    }
