"""
detector.py – YAMNet sound-classification engine for EchoTrace.

Uses TensorFlow SavedModel API directly (no tensorflow-hub import at runtime)
to avoid the tf_keras compatibility issue on Python 3.14 + TF 2.22.

YAMNet is downloaded once from TF Hub as a SavedModel and cached locally.
"""

from __future__ import annotations

import csv
import io
import logging
import os
import threading
from typing import List, Optional, Tuple

import numpy as np
import requests

from config import (
    CONFIDENCE_THRESHOLD,
    TARGET_CLASSES,
    YAMNET_CLASS_MAP_URL,
    YAMNET_MODEL_URL,
)

logger = logging.getLogger(__name__)

# Local cache directory for the downloaded SavedModel
_MODEL_CACHE_DIR = os.path.join(os.path.dirname(__file__), ".yamnet_cache")

# ---------------------------------------------------------------------------
# Thread-safe lazy initialisation
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_yamnet_model = None          # tf.saved_model loaded object
_class_names: List[str] = []  # index → display name


def _load_class_map() -> List[str]:
    """Fetch the AudioSet class-map CSV and return a list of display names."""
    logger.info("Downloading YAMNet class map from GitHub …")
    try:
        resp = requests.get(YAMNET_CLASS_MAP_URL, timeout=15)
        resp.raise_for_status()
        reader = csv.DictReader(io.StringIO(resp.text))
        names = [row["display_name"] for row in reader]
        logger.info("Loaded %d YAMNet classes.", len(names))
        return names
    except Exception as exc:
        logger.error("Could not load class map: %s", exc)
        return []


def _download_yamnet_savedmodel() -> str:
    """
    Download YAMNet SavedModel from TF Hub using requests (no hub API call).
    Returns the local path to the SavedModel directory.
    """
    import tarfile
    import tempfile

    # TF Hub stores models as tar.gz archives
    # Direct download URL for YAMNet SavedModel
    model_url = "https://tfhub.dev/google/yamnet/1?tf-hub-format=compressed"
    cache_path = _MODEL_CACHE_DIR

    # Check if already cached
    if os.path.isdir(cache_path) and os.listdir(cache_path):
        logger.info("YAMNet SavedModel found in cache: %s", cache_path)
        return cache_path

    os.makedirs(cache_path, exist_ok=True)
    logger.info("Downloading YAMNet SavedModel (this may take a moment)…")

    try:
        resp = requests.get(model_url, stream=True, timeout=120)
        resp.raise_for_status()

        # Write to a temp file first
        tmp_path = os.path.join(cache_path, "_download.tar.gz")
        with open(tmp_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)

        # Extract the tar.gz
        with tarfile.open(tmp_path, "r:gz") as tar:
            tar.extractall(cache_path)

        os.remove(tmp_path)
        logger.info("YAMNet SavedModel extracted to %s", cache_path)
        return cache_path

    except Exception as exc:
        logger.error("Failed to download YAMNet: %s. Falling back to tensorflow_hub.", exc)
        return None


def _load_model_via_hub() -> object:
    """Load YAMNet via tensorflow_hub, suppressing the tf_keras check."""
    try:
        # Monkey-patch to avoid the tf_keras import error
        import sys
        import types

        # Create a fake tf_keras module that satisfies the hub import check
        fake_keras = types.ModuleType("tf_keras")
        fake_keras.__version__ = "2.15.0"
        sys.modules.setdefault("tf_keras", fake_keras)

        import tensorflow_hub as hub
        model = hub.load(YAMNET_MODEL_URL)
        return model
    except Exception as exc:
        logger.error("tensorflow_hub load failed: %s", exc)
        return None


def _load_model() -> None:
    """Load YAMNet — tries SavedModel download first, falls back to hub."""
    global _yamnet_model, _class_names

    with _lock:
        if _yamnet_model is not None:
            return

        import tensorflow as tf

        # Strategy 1: Download SavedModel directly via requests
        model_path = _download_yamnet_savedmodel()
        if model_path and os.path.isdir(model_path):
            try:
                logger.info("Loading YAMNet from local SavedModel …")
                _yamnet_model = tf.saved_model.load(model_path)
                logger.info("YAMNet loaded via SavedModel API.")
            except Exception as exc:
                logger.warning("SavedModel load failed (%s), trying hub …", exc)
                _yamnet_model = None

        # Strategy 2: Fall back to tensorflow_hub with monkey-patch
        if _yamnet_model is None:
            logger.info("Attempting tensorflow_hub fallback …")
            _yamnet_model = _load_model_via_hub()

        if _yamnet_model is not None:
            _class_names = _load_class_map()
            logger.info("YAMNet ready with %d classes.", len(_class_names))
        else:
            logger.error("Could not load YAMNet model by any method.")


# Kick off background load immediately
_load_thread = threading.Thread(target=_load_model, daemon=True)
_load_thread.start()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def is_model_ready() -> bool:
    return _yamnet_model is not None and len(_class_names) > 0


def get_class_names() -> List[str]:
    return _class_names


def process_audio(waveform: np.ndarray) -> Optional[Tuple[str, float]]:
    """
    Run YAMNet on a 1-D float32 waveform at 16 kHz.
    Returns (class_name, confidence) if it matches TARGET_CLASSES above threshold.
    """
    if _yamnet_model is None or not _class_names:
        return None

    waveform = np.array(waveform, dtype=np.float32)
    if waveform.ndim != 1:
        waveform = waveform.flatten()

    max_val = np.max(np.abs(waveform))
    if max_val > 1.0:
        waveform = waveform / max_val

    if len(waveform) == 0:
        return None

    try:
        import tensorflow as tf

        waveform_tensor = tf.constant(waveform, dtype=tf.float32)
        scores, _embeddings, _spectrogram = _yamnet_model(waveform_tensor)

        mean_scores = tf.reduce_mean(scores, axis=0).numpy()

        top_idx = int(np.argmax(mean_scores))
        top_conf = float(mean_scores[top_idx])

        if top_idx >= len(_class_names):
            return None

        top_class = _class_names[top_idx]

        if top_conf < CONFIDENCE_THRESHOLD:
            return None

        top_lower = top_class.lower()
        for target in TARGET_CLASSES:
            if target.lower() in top_lower or top_lower in target.lower():
                return (top_class, top_conf)

        return None

    except Exception as exc:
        logger.error("YAMNet inference error: %s", exc)
        return None


def get_top_predictions(waveform: np.ndarray, top_k: int = 5) -> List[Tuple[str, float]]:
    """Return top-k predictions without TARGET_CLASSES filtering (for debugging)."""
    if _yamnet_model is None or not _class_names:
        return []

    import tensorflow as tf

    waveform = np.array(waveform, dtype=np.float32).flatten()
    max_val = np.max(np.abs(waveform))
    if max_val > 1.0:
        waveform = waveform / max_val

    try:
        waveform_tensor = tf.constant(waveform, dtype=tf.float32)
        scores, _, _ = _yamnet_model(waveform_tensor)
        mean_scores = tf.reduce_mean(scores, axis=0).numpy()
        top_indices = np.argsort(mean_scores)[::-1][:top_k]
        return [(_class_names[i], float(mean_scores[i])) for i in top_indices if i < len(_class_names)]
    except Exception as exc:
        logger.error("get_top_predictions error: %s", exc)
        return []
