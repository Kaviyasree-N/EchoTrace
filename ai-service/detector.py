"""
ai-service/detector.py – Google YAMNet Sound Classification Engine
Loads pretrained YAMNet model from TensorFlow Hub and runs real inference
on 16 kHz mono audio waveforms mapped to AudioSet classes, enhanced with:
- Audio preprocessing (DC removal, 75 Hz high-pass filtering)
- Voice Activity Detection (VAD) for speech vs. footstep disambiguation
- Explicit AudioSet -> EchoTrace target class mapping (including Glass & Shatter)
- Category-specific confidence thresholds
- Temporal smoothing & confirmation across consecutive audio chunks
"""

import csv
import io
import logging
import os
import threading
import time
from collections import deque
from typing import Any, Deque, Dict, List, Optional, Tuple

from audio_processor import analyze_voice_activity, preprocess_for_inference
from config import (
    AUDIOSET_TO_TARGET,
    CATEGORY_THRESHOLDS,
    CLASS_TO_CATEGORY,
    CONFIDENCE_THRESHOLD,
    CRITICAL_CLASSES,
    FOOTSTEPS_CONFIRMATION_CHUNKS,
    FOOTSTEPS_HIGH_CONF_BYPASS,
    SAMPLE_RATE,
    SPEECH_CLASSES,
    TARGET_CLASSES,
    TEMPORAL_EMA_ALPHA,
    TEMPORAL_SESSION_TTL_SEC,
    TEMPORAL_SMOOTHING_WINDOW,
    YAMNET_CLASS_MAP_URL,
    YAMNET_MODEL_URL,
)

logger = logging.getLogger("EchoTrace-Detector")

# State & synchronization
_lock = threading.Lock()
_yamnet_model = None
_class_names: List[str] = []
_audioset_index_to_target: Dict[int, str] = {}
_model_status: str = "uninitialized"  # "uninitialized", "loading", "ready", "fallback", "failed"
_is_neural_network: bool = False
_model_load_error: Optional[str] = None

# Normalized lowercase AudioSet lookup
_AUDIOSET_LOWER_TO_TARGET: Dict[str, str] = {
    k.strip().lower(): v for k, v in AUDIOSET_TO_TARGET.items()
}


def get_effective_threshold(sound_class: str, base_threshold: Optional[float] = None) -> float:
    """
    Compute category-specific confidence threshold for a canonical sound class,
    respecting user-configured base_threshold while preserving safety margins.
    """
    base = CONFIDENCE_THRESHOLD if base_threshold is None else max(0.05, min(0.95, float(base_threshold)))
    category = CLASS_TO_CATEGORY.get(sound_class, "default")
    cat_default = CATEGORY_THRESHOLDS.get(category, CONFIDENCE_THRESHOLD)
    delta = base - CONFIDENCE_THRESHOLD

    if category == "critical":
        # Keep smoke/fire/glass break highly responsive even if user raises default slightly
        return round(max(0.25, min(0.75, cat_default + delta * 0.5)), 3)
    if category == "footsteps":
        # Never allow footsteps threshold below 0.50 to prevent low-confidence speech false positives
        return round(max(0.50, min(0.95, cat_default + delta)), 3)
    if category == "speech":
        return round(max(0.25, min(0.90, cat_default + delta)), 3)
    if category == "impact":
        return round(max(0.38, min(0.92, cat_default + delta)), 3)
    return round(base, 3)


class TemporalPredictionSmoother:
    """
    Maintains per-session EMA target class scores and consecutive-chunk confirmation
    across consecutive 1.0s audio chunks to suppress isolated false positives
    (especially transient speech -> Footsteps misclassifications).
    Critical emergency classes bypass multi-chunk lag for instant alerting.
    """

    def __init__(
        self,
        window_size: int = TEMPORAL_SMOOTHING_WINDOW,
        alpha: float = TEMPORAL_EMA_ALPHA,
        ttl_sec: float = TEMPORAL_SESSION_TTL_SEC,
    ):
        self._lock = threading.Lock()
        self._window_size = max(2, window_size)
        self._alpha = max(0.1, min(1.0, alpha))
        self._ttl_sec = ttl_sec
        self._sessions: Dict[str, Dict[str, Any]] = {}

    def reset(self, session_id: Optional[str] = None) -> None:
        with self._lock:
            if session_id is None:
                self._sessions.clear()
            else:
                self._sessions.pop(session_id or "default", None)

    def _evict_stale_locked(self, now: float) -> None:
        stale_keys = [
            sid for sid, state in self._sessions.items()
            if (now - state["last_seen"]) > self._ttl_sec
        ]
        for sid in stale_keys:
            self._sessions.pop(sid, None)

    def _get_session_locked(self, session_key: str, now: float) -> Dict[str, Any]:
        self._evict_stale_locked(now)
        state = self._sessions.get(session_key)
        if state is None:
            state = {
                "last_seen": now,
                "ema_scores": {},
                "history": deque(maxlen=self._window_size),
                "consecutive": {},
            }
            self._sessions[session_key] = state
        else:
            state["last_seen"] = now
        return state

    def evaluate(
        self,
        session_id: Optional[str],
        raw_target_scores: Dict[str, float],
        vad_info: Dict[str, Any],
        base_threshold: Optional[float] = None,
        bypass_smoothing: bool = False,
    ) -> Tuple[Optional[str], float, Dict[str, float], bool]:
        """
        Update temporal state and return:
        (selected_class, selected_confidence, smoothed_scores, was_smoothed)
        """
        now = time.monotonic()
        session_key = (session_id or "default").strip() or "default"

        with self._lock:
            state = self._get_session_locked(session_key, now)
            ema_scores: Dict[str, float] = state["ema_scores"]
            consecutive: Dict[str, int] = state["consecutive"]
            history: Deque[Optional[str]] = state["history"]

            # 1. Immediate Critical / Emergency Path (no smoothing delay)
            # Order prioritizes life-safety alarms and shatter first
            critical_priority = [
                "Smoke detector, smoke alarm",
                "Fire alarm",
                "Glass breaking",
                "Loud impacts",
                "Crying, sobbing",
            ]
            for crit_cls in critical_priority:
                crit_score = raw_target_scores.get(crit_cls, 0.0)
                crit_thresh = get_effective_threshold(crit_cls, base_threshold)
                if crit_score >= crit_thresh:
                    # Guard Loud impacts against strong voiced speech plosives
                    if crit_cls == "Loud impacts" and vad_info.get("is_speech_active"):
                        speech_score = max(
                            raw_target_scores.get("Speech", 0.0),
                            raw_target_scores.get("Conversation", 0.0),
                        )
                        if speech_score >= crit_score * 0.75 and crit_score < 0.68:
                            continue

                    # Update EMA lightly and return immediately
                    ema_scores[crit_cls] = round(crit_score, 4)
                    history.append(crit_cls)
                    consecutive[crit_cls] = consecutive.get(crit_cls, 0) + 1
                    return crit_cls, round(crit_score, 3), dict(ema_scores), False

            # 2. Update EMA scores for all classes
            all_keys = set(ema_scores.keys()) | set(raw_target_scores.keys())
            new_ema: Dict[str, float] = {}
            for cls in all_keys:
                curr = raw_target_scores.get(cls, 0.0)
                prev = ema_scores.get(cls, 0.0)
                if bypass_smoothing or not ema_scores:
                    val = curr
                else:
                    val = self._alpha * curr + (1.0 - self._alpha) * prev
                if val >= 0.01:
                    new_ema[cls] = round(val, 4)

            state["ema_scores"] = new_ema

            # 3. Apply VAD speech-priority disambiguation
            adjusted_scores = dict(new_ema)
            speech_active = bool(vad_info.get("is_speech_active", False))
            speech_prob = float(vad_info.get("speech_probability", 0.0))
            voiced_ratio = float(vad_info.get("voiced_frame_ratio", 0.0))
            low_ratio = float(vad_info.get("low_band_ratio", 0.0))
            speech_ratio = float(vad_info.get("speech_band_ratio", 0.0))

            speech_score = max(
                adjusted_scores.get("Speech", 0.0),
                adjusted_scores.get("Conversation", 0.0),
            )
            raw_speech = max(
                raw_target_scores.get("Speech", 0.0),
                raw_target_scores.get("Conversation", 0.0),
            )
            raw_footsteps = raw_target_scores.get("Footsteps", 0.0)

            if speech_active or (speech_prob >= 0.45 and voiced_ratio >= 0.30):
                # Suppress Footsteps when acoustic profile indicates human speech
                if "Footsteps" in adjusted_scores:
                    unambiguous_footsteps = (
                        raw_footsteps >= 0.75
                        and low_ratio > speech_ratio * 1.15
                        and raw_footsteps > raw_speech + 0.25
                    )
                    if not unambiguous_footsteps:
                        adjusted_scores["Footsteps"] = round(adjusted_scores["Footsteps"] * 0.35, 4)

                # If speech is active and raw/smoothed speech is near threshold, prioritize Speech
                if speech_score > 0.0 and "Speech" in adjusted_scores:
                    if adjusted_scores.get("Footsteps", 0.0) > adjusted_scores["Speech"] and not (
                        raw_footsteps > raw_speech + 0.25
                    ):
                        adjusted_scores["Footsteps"] = round(adjusted_scores["Speech"] * 0.70, 4)

            # 4. Select best candidate above its category-specific threshold
            candidates: List[Tuple[str, float]] = []
            for cls, score in adjusted_scores.items():
                thresh = get_effective_threshold(cls, base_threshold)
                if score >= thresh:
                    candidates.append((cls, score))

            candidates.sort(key=lambda item: item[1], reverse=True)

            if not candidates:
                history.append(None)
                # Decay consecutive counters when silence/non-target returns
                for k in list(consecutive.keys()):
                    consecutive[k] = 0
                return None, 0.0, new_ema, not bypass_smoothing

            top_cls, top_score = candidates[0]

            # Update consecutive counts
            for k in list(consecutive.keys()):
                if k != top_cls:
                    consecutive[k] = 0
            consecutive[top_cls] = consecutive.get(top_cls, 0) + 1
            history.append(top_cls)

            # 5. Require multi-chunk confirmation for Footsteps unless bypass or very high impulsive score
            if top_cls == "Footsteps" and not bypass_smoothing:
                confirmed_by_chunks = consecutive["Footsteps"] >= FOOTSTEPS_CONFIRMATION_CHUNKS
                confirmed_by_high_conf = (
                    raw_footsteps >= FOOTSTEPS_HIGH_CONF_BYPASS
                    and not speech_active
                    and speech_prob < 0.35
                )
                if not (confirmed_by_chunks or confirmed_by_high_conf):
                    # Check if Speech is a valid secondary candidate while Footsteps is held for confirmation
                    for sec_cls, sec_score in candidates[1:]:
                        if sec_cls in SPEECH_CLASSES and speech_active:
                            return sec_cls, round(sec_score, 3), new_ema, True
                    return None, 0.0, new_ema, True

            return top_cls, round(top_score, 3), new_ema, not bypass_smoothing


_temporal_smoother = TemporalPredictionSmoother()


def reset_temporal_state(session_id: Optional[str] = None) -> None:
    """Reset temporal smoothing state (primarily for tests or session cleanup)."""
    _temporal_smoother.reset(session_id)


def _rebuild_index_map(class_names: List[str]) -> Dict[int, str]:
    """Map AudioSet 521 class indices to canonical EchoTrace TARGET_CLASSES."""
    mapping: Dict[int, str] = {}
    target_lower_map = {t.lower(): t for t in TARGET_CLASSES}

    for idx, name in enumerate(class_names):
        key = name.strip().lower()
        if key in _AUDIOSET_LOWER_TO_TARGET:
            mapping[idx] = _AUDIOSET_LOWER_TO_TARGET[key]
        elif key in target_lower_map:
            mapping[idx] = target_lower_map[key]

    return mapping


def load_class_map() -> List[str]:
    """
    Load AudioSet 521 class display names.
    Checks local CSV file first, falls back to GitHub URL, then TARGET_CLASSES.
    """
    global _audioset_index_to_target
    local_csv = os.path.join(os.path.dirname(__file__), "yamnet_class_map.csv")
    if os.path.isfile(local_csv):
        try:
            with open(local_csv, mode="r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                names = [row["display_name"] for row in reader]
                if len(names) >= 500:
                    _audioset_index_to_target = _rebuild_index_map(names)
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
            _audioset_index_to_target = _rebuild_index_map(names)
            logger.info("Downloaded %d AudioSet classes from GitHub.", len(names))
            return names
    except Exception as exc:
        logger.warning("Could not download class map (%s); using default TARGET_CLASSES.", exc)
        names = list(TARGET_CLASSES)
        _audioset_index_to_target = _rebuild_index_map(names)
        return names


def init_model() -> None:
    """
    Initialize YAMNet model only once in memory.
    Attempts TensorFlow Hub load first; if unavailable, switches cleanly to fallback status.
    """
    global _yamnet_model, _class_names, _audioset_index_to_target
    global _model_status, _is_neural_network, _model_load_error

    with _lock:
        if _model_status in ("ready", "fallback") and (_yamnet_model is not None or _model_status == "fallback"):
            return

        _model_status = "loading"
        _class_names = load_class_map()
        _audioset_index_to_target = _rebuild_index_map(_class_names)

        try:
            logger.info("Loading Google YAMNet model from TensorFlow Hub: %s", YAMNET_MODEL_URL)
            import tensorflow as tf
            import tensorflow_hub as hub

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


def classify_waveform(
    samples: List[float],
    top_k: int = 5,
    client_session_id: Optional[str] = None,
    confidence_threshold: Optional[float] = None,
    bypass_smoothing: bool = False,
) -> Optional[Dict]:
    """
    Run sound classification on 16 kHz mono waveform.
    Uses genuine YAMNet neural network if ready, or enhanced VAD + spectral fallback if unavailable.
    """
    if not samples or len(samples) < int(SAMPLE_RATE * 0.15):
        return None

    duration = round(len(samples) / SAMPLE_RATE, 2)
    cleaned_samples = preprocess_for_inference(samples, sample_rate=SAMPLE_RATE)
    vad_info = analyze_voice_activity(cleaned_samples, sample_rate=SAMPLE_RATE)

    if vad_info.get("is_silent"):
        return None

    # 1. Genuine Google YAMNet Neural Network Path
    if _is_neural_network and _yamnet_model is not None:
        try:
            import numpy as np
            import tensorflow as tf

            waveform = np.array(cleaned_samples, dtype=np.float32).flatten()
            max_amp = np.max(np.abs(waveform))
            if max_amp > 1.0:
                waveform = waveform / max_amp

            waveform_tensor = tf.constant(waveform, dtype=tf.float32)

            # Model outputs: scores (N, 521), embeddings (N, 1024), spectrogram (M, 64)
            scores, _embeddings, _spectrogram = _yamnet_model(waveform_tensor)

            mean_scores = tf.reduce_mean(scores, axis=0).numpy()
            max_scores = tf.reduce_max(scores, axis=0).numpy()
            # Blend mean and max pooling so brief critical alarms/shatters aren't diluted
            blended_scores = 0.60 * mean_scores + 0.40 * max_scores

            # Build raw predictions list (top_k) from blended AudioSet scores
            ranked_indices = np.argsort(mean_scores)[::-1]
            all_predictions = []
            for idx in ranked_indices[:top_k]:
                idx_int = int(idx)
                if idx_int < len(_class_names):
                    all_predictions.append({
                        "sound_class": _class_names[idx_int],
                        "confidence": round(float(mean_scores[idx_int]), 3),
                    })

            # Aggregate ALL 521 AudioSet scores mapped to canonical TARGET_CLASSES
            if not _audioset_index_to_target and _class_names:
                _audioset_index_to_target.update(_rebuild_index_map(_class_names))

            target_raw_scores: Dict[str, float] = {}
            for idx_int, canonical_target in _audioset_index_to_target.items():
                if idx_int >= len(mean_scores):
                    continue
                # Critical / impulsive classes benefit from blended max+mean; continuous use mean
                if canonical_target in CRITICAL_CLASSES or canonical_target in ("Knock", "Door", "Doorbell"):
                    score_val = float(blended_scores[idx_int])
                else:
                    score_val = float(mean_scores[idx_int])

                prev_val = target_raw_scores.get(canonical_target, 0.0)
                if score_val > prev_val:
                    target_raw_scores[canonical_target] = score_val

            # Boost Speech score slightly when VAD strongly detects harmonic voiced speech
            # and YAMNet reports moderate Speech probability (e.g. near-mic speech)
            if vad_info.get("is_speech_active") and vad_info.get("speech_probability", 0.0) >= 0.65:
                if "Speech" in target_raw_scores and target_raw_scores["Speech"] >= 0.22:
                    target_raw_scores["Speech"] = min(1.0, target_raw_scores["Speech"] * 1.12)

            matched_sound, matched_conf, _smoothed_map, was_smoothed = _temporal_smoother.evaluate(
                session_id=client_session_id,
                raw_target_scores=target_raw_scores,
                vad_info=vad_info,
                base_threshold=confidence_threshold,
                bypass_smoothing=bypass_smoothing,
            )

            if matched_sound:
                return {
                    "sound_class": matched_sound,
                    "confidence": matched_conf,
                    "duration": duration,
                    "inference_engine": "yamnet_neural_network",
                    "predictions": all_predictions,
                    "vad": {
                        "is_speech_active": vad_info["is_speech_active"],
                        "speech_probability": vad_info["speech_probability"],
                    },
                    "smoothed": was_smoothed,
                }

            return {
                "sound_class": None,
                "confidence": 0.0,
                "duration": duration,
                "inference_engine": "yamnet_neural_network",
                "predictions": all_predictions,
                "vad": {
                    "is_speech_active": vad_info["is_speech_active"],
                    "speech_probability": vad_info["speech_probability"],
                },
                "smoothed": was_smoothed,
            }

        except Exception as exc:
            logger.error("YAMNet neural inference error: %s", exc)

    # 2. Enhanced VAD + Acoustic Spectral Fallback Path (when TensorFlow model is unavailable)
    return acoustic_spectral_classify(
        cleaned_samples,
        duration,
        vad_info=vad_info,
        client_session_id=client_session_id,
        confidence_threshold=confidence_threshold,
        bypass_smoothing=bypass_smoothing,
    )


def acoustic_spectral_classify(
    samples: List[float],
    duration: float,
    vad_info: Optional[Dict[str, Any]] = None,
    client_session_id: Optional[str] = None,
    confidence_threshold: Optional[float] = None,
    bypass_smoothing: bool = False,
) -> Optional[Dict]:
    """
    VAD-aware acoustic spectral feature classifier used ONLY when YAMNet neural model
    cannot be loaded. Fixes speech-vs-footsteps priority, preserves smoke/glass break
    detection, and applies temporal smoothing.
    """
    if not samples:
        return None

    if vad_info is None:
        cleaned = preprocess_for_inference(samples, sample_rate=SAMPLE_RATE)
        vad_info = analyze_voice_activity(cleaned, sample_rate=SAMPLE_RATE)

    if vad_info.get("is_silent"):
        return None

    rms = vad_info["rms"]
    zcr = vad_info["zcr"]
    active_zcr = vad_info.get("active_zcr", zcr)
    crest = vad_info["crest"]
    energy_variance = vad_info["energy_variance"]
    active_frame_ratio = vad_info["active_frame_ratio"]
    voiced_frame_ratio = vad_info["voiced_frame_ratio"]
    mean_voicing = vad_info.get("mean_voicing", 0.0)
    speech_prob = vad_info["speech_probability"]
    is_speech_active = vad_info["is_speech_active"]
    is_impulsive = vad_info["is_impulsive"]

    low_ratio = vad_info["low_band_ratio"]
    speech_ratio = vad_info["speech_band_ratio"]
    alarm_ratio = vad_info["alarm_band_ratio"]
    high_ratio = vad_info["high_band_ratio"]
    alarm_tonality = vad_info["alarm_tonality"]
    alarm_dominance = vad_info.get("alarm_dominance", 0.0)

    # Score candidate classes instead of brittle if/elif fall-through
    candidate_scores: Dict[str, float] = {}

    # 1. Critical: Smoke detector / Fire alarm (sustained narrowband 2.7-3.55 kHz resonant tone)
    if (
        alarm_ratio >= 0.50
        and alarm_tonality >= 0.35
        and alarm_dominance >= 0.60
        and rms >= 0.03
        and not (is_impulsive and crest >= 3.4)
    ):
        score = min(0.96, 0.55 + alarm_ratio * 0.25 + alarm_tonality * 0.20)
        candidate_scores["Smoke detector, smoke alarm"] = round(score, 3)

    # 2. Critical: Glass breaking (sharp impulsive high-frequency shatter >2.5 kHz)
    if high_ratio >= 0.42 and active_zcr >= 0.23 and crest >= 3.3 and not is_speech_active:
        score = min(0.94, 0.48 + high_ratio * 0.30 + min(0.20, (crest - 3.0) * 0.08))
        candidate_scores["Glass breaking"] = round(score, 3)

    # 3. Speech (checked with high priority via VAD voicing + speech-band dominance)
    if is_speech_active or (
        mean_voicing >= 0.38 and speech_ratio >= 0.42 and 0.03 <= active_zcr <= 0.23
    ):
        speech_conf = min(
            0.94,
            0.46 + speech_prob * 0.36 + voiced_frame_ratio * 0.12,
        )
        candidate_scores["Speech"] = round(speech_conf, 3)

    # 4. Keys jingling / Dishes (high ZCR metallic/ceramic clutter, non-tonal)
    if active_zcr > 0.25 and crest > 3.5 and alarm_tonality < 0.35 and not is_speech_active and "Glass breaking" not in candidate_scores:
        candidate_scores["Keys jingling"] = 0.84
    elif active_zcr > 0.22 and energy_variance > 0.06 and high_ratio >= 0.30 and not is_speech_active and "Glass breaking" not in candidate_scores:
        candidate_scores["Dishes, pots, and pans"] = 0.82

    # 5. Knock / Door (sharp low-mid single impulse, non-voiced, non-speech)
    if (
        is_impulsive
        and active_zcr < 0.10
        and crest > 3.3
        and voiced_frame_ratio < 0.20
        and not is_speech_active
    ):
        cls = "Knock" if duration < 1.2 else "Door"
        candidate_scores[cls] = 0.82

    # 6. Footsteps (strictly low-band impulsive bursts with quiet gaps, NEVER voiced speech)
    if (
        low_ratio >= 0.45
        and low_ratio > speech_ratio
        and active_zcr < 0.12
        and energy_variance > 0.035
        and active_frame_ratio <= 0.50
        and (voiced_frame_ratio < 0.20 or (low_ratio >= 0.55 and speech_ratio < 0.30))
        and speech_prob < 0.35
    ):
        foot_conf = min(0.86, 0.52 + low_ratio * 0.28 + (0.10 if is_impulsive else 0.0))
        candidate_scores["Footsteps"] = round(foot_conf, 3)

    # 7. Water tap, faucet (steady mid-high broadband flow, low energy variance, unvoiced)
    if (
        0.12 <= active_zcr <= 0.24
        and energy_variance < 0.035
        and rms > 0.04
        and voiced_frame_ratio < 0.25
        and not is_speech_active
    ):
        candidate_scores["Water tap, faucet"] = 0.80

    # Ranked prediction list (provide top non-zero spectral candidates for transparency)
    if not candidate_scores:
        # Provide diagnostic top prediction below threshold without triggering false Drawer event
        fallback_label = "Speech" if speech_prob >= 0.30 else "Loud impacts" if is_impulsive else "Water tap, faucet"
        fallback_conf = round(max(0.12, min(0.32, rms * 0.8)), 3)
        predictions = [{"sound_class": fallback_label, "confidence": fallback_conf}]
        return {
            "sound_class": None,
            "confidence": 0.0,
            "duration": duration,
            "inference_engine": "acoustic_spectral_fallback",
            "predictions": predictions,
            "vad": {
                "is_speech_active": is_speech_active,
                "speech_probability": speech_prob,
            },
            "smoothed": False,
        }

    sorted_preds = sorted(candidate_scores.items(), key=lambda item: item[1], reverse=True)
    predictions = [{"sound_class": cls, "confidence": conf} for cls, conf in sorted_preds[:5]]

    matched_sound, matched_conf, _smoothed_map, was_smoothed = _temporal_smoother.evaluate(
        session_id=client_session_id,
        raw_target_scores=candidate_scores,
        vad_info=vad_info,
        base_threshold=confidence_threshold,
        bypass_smoothing=bypass_smoothing,
    )

    return {
        "sound_class": matched_sound,
        "confidence": matched_conf if matched_sound else 0.0,
        "duration": duration,
        "inference_engine": "acoustic_spectral_fallback",
        "predictions": predictions,
        "vad": {
            "is_speech_active": is_speech_active,
            "speech_probability": speech_prob,
        },
        "smoothed": was_smoothed,
    }
