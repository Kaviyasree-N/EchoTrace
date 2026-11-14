"""
ai-service/audio_processor.py – Audio preprocessing and Voice Activity Detection (VAD)
Decodes WAV, PCM 16-bit / 24-bit / 32-bit, converts to 16 kHz mono float32,
normalizes waveforms, removes DC/sub-bass rumble, and computes VAD/spectral features.
"""

import io
import math
import wave
from typing import Any, Dict, List, Tuple

from config import SAMPLE_RATE, VAD_SILENCE_RMS, VAD_SPEECH_ACTIVE_THRESHOLD

try:
    import numpy as _np
except ImportError:
    _np = None


def decode_audio_payload(data: bytes, content_type: str = "") -> List[float]:
    """
    Decodes audio bytes into a 16 kHz mono float32 waveform list in range [-1.0, 1.0].
    Supports WAV format, raw PCM 16-bit, or raw float32.
    """
    if not data or len(data) < 32:
        return []

    # Check for RIFF / WAVE format header
    if data.startswith(b"RIFF") and b"WAVE" in data[:16]:
        try:
            with wave.open(io.BytesIO(data), "rb") as wav_file:
                channels = wav_file.getnchannels()
                sample_width = wav_file.getsampwidth()
                framerate = wav_file.getframerate()
                n_frames = wav_file.getnframes()
                raw_bytes = wav_file.readframes(n_frames)

                samples: List[float] = []

                if sample_width == 2:  # 16-bit signed PCM
                    step = 2 * channels
                    for i in range(0, len(raw_bytes) - step + 1, step):
                        channel_sum = 0
                        for ch in range(channels):
                            offset = i + (ch * 2)
                            val = int.from_bytes(raw_bytes[offset:offset + 2], byteorder="little", signed=True)
                            channel_sum += val
                        samples.append((channel_sum / channels) / 32768.0)

                elif sample_width == 3:  # 24-bit signed PCM
                    step = 3 * channels
                    for i in range(0, len(raw_bytes) - step + 1, step):
                        channel_sum = 0
                        for ch in range(channels):
                            offset = i + (ch * 3)
                            val = int.from_bytes(raw_bytes[offset:offset + 3], byteorder="little", signed=True)
                            channel_sum += val
                        samples.append((channel_sum / channels) / 8388608.0)

                elif sample_width == 1:  # 8-bit unsigned PCM
                    step = channels
                    for i in range(0, len(raw_bytes) - step + 1, step):
                        channel_sum = 0
                        for ch in range(channels):
                            val = raw_bytes[i + ch] - 128
                            channel_sum += val
                        samples.append((channel_sum / channels) / 128.0)

                elif sample_width == 4:  # 32-bit float
                    import struct
                    step = 4 * channels
                    for i in range(0, len(raw_bytes) - step + 1, step):
                        channel_sum = 0.0
                        for ch in range(channels):
                            offset = i + (ch * 4)
                            try:
                                val = struct.unpack('<f', raw_bytes[offset:offset + 4])[0]
                                channel_sum += val
                            except Exception:
                                pass
                        samples.append(channel_sum / channels)

                # Resample if not 16,000 Hz
                if framerate != SAMPLE_RATE and framerate > 0 and len(samples) > 0:
                    samples = resample_linear(samples, framerate, SAMPLE_RATE)

                return normalize_waveform(samples)

        except Exception:
            # If WAV header parse fails, fall back to raw PCM interpretation
            pass

    # Treat as raw 16-bit signed little-endian PCM mono at 16kHz
    samples = []
    for i in range(0, len(data) - 1, 2):
        val = int.from_bytes(data[i:i + 2], byteorder="little", signed=True)
        samples.append(val / 32768.0)

    return normalize_waveform(samples)


def resample_linear(samples: List[float], orig_sr: int, target_sr: int) -> List[float]:
    """High-performance linear resampler for mono float waveforms."""
    if orig_sr == target_sr or not samples:
        return samples

    ratio = orig_sr / target_sr
    new_len = int(len(samples) / ratio)
    if new_len == 0:
        return []

    output = [0.0] * new_len

    for i in range(new_len):
        src_idx = i * ratio
        idx0 = int(src_idx)
        idx1 = min(idx0 + 1, len(samples) - 1)
        frac = src_idx - idx0
        output[i] = (1.0 - frac) * samples[idx0] + frac * samples[idx1]

    return output


def normalize_waveform(samples: List[float]) -> List[float]:
    """Clamp waveform to [-1.0, 1.0] and scale down only if clipping occurs."""
    if not samples:
        return []

    max_amp = max(abs(s) for s in samples)
    if max_amp > 1.0:
        return [max(-1.0, min(1.0, s / max_amp)) for s in samples]
    return [max(-1.0, min(1.0, s)) for s in samples]


def remove_dc_offset(samples: List[float]) -> List[float]:
    """Remove DC bias from a mono waveform."""
    if not samples:
        return []
    mean_val = sum(samples) / len(samples)
    if abs(mean_val) < 1e-6:
        return list(samples)
    return [s - mean_val for s in samples]


def highpass_filter(samples: List[float], sample_rate: int = SAMPLE_RATE, cutoff_hz: float = 75.0) -> List[float]:
    """
    First-order IIR high-pass filter to attenuate sub-bass mic handling,
    wind, and HVAC rumble (< 75 Hz) without removing speech fundamentals or footsteps.
    """
    if not samples or len(samples) < 4 or cutoff_hz <= 0 or sample_rate <= 0:
        return list(samples)

    rc = 1.0 / (2.0 * math.pi * cutoff_hz)
    dt = 1.0 / float(sample_rate)
    alpha = rc / (rc + dt)

    filtered = [0.0] * len(samples)
    prev_x = samples[0]
    prev_y = 0.0
    for i, x in enumerate(samples):
        y = alpha * (prev_y + x - prev_x)
        filtered[i] = y
        prev_x = x
        prev_y = y
    return filtered


def preprocess_for_inference(samples: List[float], sample_rate: int = SAMPLE_RATE) -> List[float]:
    """
    Clean raw audio before classification:
    1. Remove DC offset
    2. Gentle 75 Hz high-pass filter to suppress mic-bump DC/sub-bass thumps
    3. Clamp to [-1.0, 1.0]
    """
    if not samples:
        return []
    centered = remove_dc_offset(samples)
    hp = highpass_filter(centered, sample_rate=sample_rate, cutoff_hz=75.0)
    return normalize_waveform(hp)


def compute_audio_stats(samples: List[float]) -> Tuple[float, float]:
    """Compute RMS energy and peak amplitude."""
    if not samples:
        return 0.0, 0.0

    rms = math.sqrt(sum(s * s for s in samples) / len(samples))
    peak = max(abs(s) for s in samples)
    return round(rms, 4), round(peak, 4)


_FFT_N = 256
_HANN_256 = [0.5 * (1.0 - math.cos((2.0 * math.pi * i) / (_FFT_N - 1))) for i in range(_FFT_N)]


def _fft_power_spectrum_256(frame: List[float]) -> List[float]:
    """
    Pure-Python 256-point Hann-windowed radix-2 Cooley-Tukey FFT power spectrum.
    Returns bins 0..128 (0 Hz to Nyquist, ~62.5 Hz resolution at 16 kHz) with zero blind spots.
    """
    n = _FFT_N
    if len(frame) >= n:
        # Center 256 samples within 320-sample frame
        offset = (len(frame) - n) // 2
        real = [frame[offset + i] * _HANN_256[i] for i in range(n)]
    else:
        padded = list(frame) + [0.0] * (n - len(frame))
        real = [padded[i] * _HANN_256[i] for i in range(n)]
    imag = [0.0] * n

    # Bit-reversal permutation
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j ^= bit
        if i < j:
            real[i], real[j] = real[j], real[i]
            imag[i], imag[j] = imag[j], imag[i]

    # Cooley-Tukey butterfly stages
    length = 2
    while length <= n:
        half = length // 2
        angle_step = -2.0 * math.pi / length
        w_step_r = math.cos(angle_step)
        w_step_i = math.sin(angle_step)
        for start in range(0, n, length):
            w_r = 1.0
            w_i = 0.0
            for k in range(half):
                even_idx = start + k
                odd_idx = even_idx + half
                t_r = w_r * real[odd_idx] - w_i * imag[odd_idx]
                t_i = w_r * imag[odd_idx] + w_i * real[odd_idx]
                u_r = real[even_idx]
                u_i = imag[even_idx]
                real[even_idx] = u_r + t_r
                imag[even_idx] = u_i + t_i
                real[odd_idx] = u_r - t_r
                imag[odd_idx] = u_i - t_i
                next_wr = w_r * w_step_r - w_i * w_step_i
                w_i = w_r * w_step_i + w_i * w_step_r
                w_r = next_wr
        length <<= 1

    half_n = n // 2 + 1
    return [(real[k] * real[k] + imag[k] * imag[k]) for k in range(half_n)]


def _frame_voicing_score(frame: List[float], sample_rate: int) -> float:
    """
    Estimate periodic voicing strength in human pitch range (75 Hz - 380 Hz)
    via normalized autocorrelation. Speech vowels score high (>= 0.42);
    impulsive footsteps/noise score low (< 0.30).
    """
    n = len(frame)
    if n < 120:
        return 0.0

    min_lag = max(20, int(sample_rate / 380))   # ~42 samples at 16 kHz
    max_lag = min(n // 2, int(sample_rate / 75))  # ~160-213 samples
    if max_lag <= min_lag:
        return 0.0

    energy = sum(x * x for x in frame)
    if energy < 1e-8:
        return 0.0

    best_norm_corr = 0.0
    # Step by 2 samples for speed while retaining accuracy
    for lag in range(min_lag, max_lag, 2):
        limit = n - lag
        num = 0.0
        e1 = 0.0
        e2 = 0.0
        for i in range(limit):
            a = frame[i]
            b = frame[i + lag]
            num += a * b
            e1 += a * a
            e2 += b * b
        denom = math.sqrt(e1 * e2) + 1e-9
        corr = num / denom
        if corr > best_norm_corr:
            best_norm_corr = corr

    return max(0.0, min(1.0, best_norm_corr))


def _compute_band_profile(active_frames: List[List[float]], sample_rate: int) -> Dict[str, float]:
    """
    Compute energy distribution across acoustic bands:
    - low_band: 70-255 Hz (footsteps, thuds, bass rumble)
    - speech_band: 300-3400 Hz (human speech formants)
    - alarm_band: 2700-3550 Hz (smoke/fire alarm resonant frequencies)
    - high_band: 2500-7500 Hz (glass shatter, keys, dishes, alarms)
    """
    if not active_frames:
        return {
            "low_band_ratio": 0.0,
            "speech_band_ratio": 0.0,
            "alarm_band_ratio": 0.0,
            "high_band_ratio": 0.0,
            "alarm_tonality": 0.0,
            "alarm_dominance": 0.0,
        }

    # Sample up to 10 evenly spaced active frames for fast computation
    step = max(1, len(active_frames) // 10)
    sampled = active_frames[::step][:10]

    if _np is not None:
        arr = _np.array(sampled, dtype=_np.float32)
        window = _np.hanning(arr.shape[1]).astype(_np.float32)
        spec = _np.abs(_np.fft.rfft(arr * window, axis=1)) ** 2
        mean_spec = _np.mean(spec, axis=0)
        freqs = _np.fft.rfftfreq(arr.shape[1], d=1.0 / sample_rate)

        total_power = float(_np.sum(mean_spec[(freqs >= 70) & (freqs <= 7500)])) + 1e-12
        low_power = float(_np.sum(mean_spec[(freqs >= 70) & (freqs <= 255)]))
        speech_power = float(_np.sum(mean_spec[(freqs >= 300) & (freqs <= 3400)]))
        alarm_bins = mean_spec[(freqs >= 2700) & (freqs <= 3550)]
        alarm_power = float(_np.sum(alarm_bins))
        alarm_peak = float(_np.max(alarm_bins)) if len(alarm_bins) > 0 else 0.0
        high_power = float(_np.sum(mean_spec[(freqs >= 2500) & (freqs <= 7500)]))

        return {
            "low_band_ratio": round(low_power / total_power, 4),
            "speech_band_ratio": round(speech_power / total_power, 4),
            "alarm_band_ratio": round(alarm_power / total_power, 4),
            "high_band_ratio": round(high_power / total_power, 4),
            "alarm_tonality": round(alarm_peak / (alarm_power + 1e-12), 4),
            "alarm_dominance": round(alarm_power / (high_power + 1e-12), 4),
        }

    # Pure-Python 256-point Hann-windowed FFT across all bins (0..8 kHz)
    half_n = _FFT_N // 2 + 1
    mean_spec = [0.0] * half_n
    for frame in sampled:
        spec = _fft_power_spectrum_256(frame)
        for k in range(half_n):
            mean_spec[k] += spec[k]

    inv_count = 1.0 / max(1, len(sampled))
    df = float(sample_rate) / float(_FFT_N)

    total_power = 1e-12
    low_power = 0.0
    speech_power = 0.0
    alarm_power = 0.0
    alarm_peak = 0.0
    high_power = 0.0

    for k in range(1, half_n):
        freq = k * df
        p = mean_spec[k] * inv_count
        if 70.0 <= freq <= 7500.0:
            total_power += p
        if 70.0 <= freq <= 255.0:
            low_power += p
        if 300.0 <= freq <= 3400.0:
            speech_power += p
        if 2700.0 <= freq <= 3550.0:
            alarm_power += p
            if p > alarm_peak:
                alarm_peak = p
        if 2500.0 <= freq <= 7500.0:
            high_power += p

    return {
        "low_band_ratio": round(low_power / total_power, 4),
        "speech_band_ratio": round(speech_power / total_power, 4),
        "alarm_band_ratio": round(alarm_power / total_power, 4),
        "high_band_ratio": round(high_power / total_power, 4),
        "alarm_tonality": round(alarm_peak / (alarm_power + 1e-12), 4),
        "alarm_dominance": round(alarm_power / (high_power + 1e-12), 4),
    }


def analyze_voice_activity(samples: List[float], sample_rate: int = SAMPLE_RATE) -> Dict[str, Any]:
    """
    Multi-feature Voice Activity Detection (VAD) and acoustic profile.
    Distinguishes sustained, harmonic human speech from impulsive low-frequency footsteps
    and high-frequency emergency sounds (smoke alarms, glass breaking).
    """
    n = len(samples)
    if n == 0:
        return {
            "is_speech_active": False,
            "speech_probability": 0.0,
            "is_silent": True,
            "is_impulsive": False,
            "rms": 0.0,
            "peak": 0.0,
            "crest": 0.0,
            "zcr": 0.0,
            "active_zcr": 0.0,
            "active_frame_ratio": 0.0,
            "voiced_frame_ratio": 0.0,
            "energy_variance": 0.0,
            "low_band_ratio": 0.0,
            "speech_band_ratio": 0.0,
            "alarm_band_ratio": 0.0,
            "high_band_ratio": 0.0,
            "alarm_tonality": 0.0,
            "alarm_dominance": 0.0,
        }

    rms = math.sqrt(sum(s * s for s in samples) / n)
    peak = max(abs(s) for s in samples)
    crest = peak / (rms + 1e-6)

    zero_crossings = 0
    for i in range(1, n):
        if (samples[i] >= 0.0 and samples[i - 1] < 0.0) or (samples[i] < 0.0 and samples[i - 1] >= 0.0):
            zero_crossings += 1
    zcr = zero_crossings / n

    if rms < VAD_SILENCE_RMS:
        return {
            "is_speech_active": False,
            "speech_probability": 0.0,
            "is_silent": True,
            "is_impulsive": False,
            "rms": round(rms, 4),
            "peak": round(peak, 4),
            "crest": round(crest, 3),
            "zcr": round(zcr, 4),
            "active_zcr": 0.0,
            "active_frame_ratio": 0.0,
            "voiced_frame_ratio": 0.0,
            "energy_variance": 0.0,
            "low_band_ratio": 0.0,
            "speech_band_ratio": 0.0,
            "alarm_band_ratio": 0.0,
            "high_band_ratio": 0.0,
            "alarm_tonality": 0.0,
            "alarm_dominance": 0.0,
        }

    # Split into 20 ms frames (320 samples at 16 kHz)
    frame_len = max(160, int(sample_rate * 0.02))
    frames: List[List[float]] = []
    frame_rms_list: List[float] = []

    for start in range(0, n - frame_len + 1, frame_len):
        fr = samples[start:start + frame_len]
        frames.append(fr)
        frame_rms_list.append(math.sqrt(sum(x * x for x in fr) / frame_len))

    if not frames:
        frames = [samples]
        frame_rms_list = [rms]

    # Adaptive frame activity threshold
    sorted_rms = sorted(frame_rms_list)
    noise_floor = sorted_rms[max(0, len(sorted_rms) // 5)]
    active_thresh = max(0.012, noise_floor * 1.8, rms * 0.35)

    active_frames: List[List[float]] = []
    for fr, fr_rms in zip(frames, frame_rms_list):
        if fr_rms >= active_thresh:
            active_frames.append(fr)

    active_frame_ratio = len(active_frames) / len(frames)

    # Sub-chunk energy variance (8 chunks across window)
    num_subchunks = 8
    sub_len = max(1, n // num_subchunks)
    sub_energies = []
    for i in range(num_subchunks):
        sub = samples[i * sub_len:(i + 1) * sub_len]
        if sub:
            sub_energies.append(math.sqrt(sum(s * s for s in sub) / len(sub)))
    energy_variance = (max(sub_energies) - min(sub_energies)) if sub_energies else 0.0

    # Voicing periodicity & active ZCR across sampled active frames
    voiced_count = 0
    voicing_scores: List[float] = []
    active_zc_total = 0
    active_sample_total = 0
    step = max(1, len(active_frames) // 10)
    sampled_active = active_frames[::step][:10]
    for fr in sampled_active:
        v = _frame_voicing_score(fr, sample_rate)
        voicing_scores.append(v)
        if v >= 0.42:
            voiced_count += 1
        active_sample_total += len(fr)
        for idx in range(1, len(fr)):
            if (fr[idx] >= 0.0 and fr[idx - 1] < 0.0) or (fr[idx] < 0.0 and fr[idx - 1] >= 0.0):
                active_zc_total += 1

    active_zcr = (active_zc_total / active_sample_total) if active_sample_total > 0 else zcr
    voiced_frame_ratio = (voiced_count / len(sampled_active)) if sampled_active else 0.0
    mean_voicing = (sum(voicing_scores) / len(voicing_scores)) if voicing_scores else 0.0

    # Spectral band distribution
    bands = _compute_band_profile(active_frames if active_frames else frames[:4], sample_rate)
    low_ratio = bands["low_band_ratio"]
    speech_ratio = bands["speech_band_ratio"]
    alarm_ratio = bands["alarm_band_ratio"]
    high_ratio = bands["high_band_ratio"]
    alarm_tonality = bands["alarm_tonality"]
    alarm_dominance = bands["alarm_dominance"]

    # Impulsiveness check: short bursts separated by quiet intervals + high crest
    sorted_desc = sorted(frame_rms_list, reverse=True)
    median_frame_rms = sorted_rms[len(sorted_rms) // 2] + 1e-6
    peak_to_median_frame = sorted_desc[0] / median_frame_rms
    is_impulsive = (
        (crest >= 3.4 and active_frame_ratio <= 0.48)
        or (peak_to_median_frame >= 4.2 and active_frame_ratio <= 0.42)
    )

    # Speech probability score combining:
    # 1. Harmonic voicing periodicity (gated by presence of speech formant energy)
    # 2. Speech-band energy dominance (300-3400 Hz vs <255 Hz)
    # 3. Sustained active-frame duty cycle (speech occupies >=25% of chunk)
    # 4. Speech-typical ZCR (0.03 - 0.24) and non-alarm/non-shatter acoustics
    speech_score = 0.0

    has_speech_formants = speech_ratio >= 0.28 and speech_ratio >= low_ratio * 0.65
    if has_speech_formants:
        if mean_voicing >= 0.45:
            speech_score += 0.35
        elif mean_voicing >= 0.32:
            speech_score += 0.18

        if voiced_frame_ratio >= 0.40:
            speech_score += 0.20
        elif voiced_frame_ratio >= 0.20:
            speech_score += 0.10

    if speech_ratio >= 0.48 and speech_ratio > low_ratio * 1.25:
        speech_score += 0.25
    elif speech_ratio >= 0.35 and speech_ratio > low_ratio:
        speech_score += 0.12

    if 0.25 <= active_frame_ratio <= 0.96:
        speech_score += 0.15

    if 0.03 <= active_zcr <= 0.24:
        speech_score += 0.10

    # Penalize narrowband high-frequency alarms, broadband HF shatter, or sub-250 Hz thuds
    if alarm_ratio >= 0.50 and alarm_tonality >= 0.35 and alarm_dominance >= 0.60:
        speech_score -= 0.45
    if (high_ratio >= 0.55 and active_zcr > 0.24) or (is_impulsive and high_ratio >= 0.38):
        speech_score -= 0.40
    if low_ratio > 0.52 and speech_ratio < 0.35:
        speech_score -= 0.35

    speech_probability = round(max(0.0, min(1.0, speech_score)), 3)
    is_speech_active = speech_probability >= VAD_SPEECH_ACTIVE_THRESHOLD

    return {
        "is_speech_active": is_speech_active,
        "speech_probability": speech_probability,
        "is_silent": False,
        "is_impulsive": is_impulsive,
        "rms": round(rms, 4),
        "peak": round(peak, 4),
        "crest": round(crest, 3),
        "zcr": round(zcr, 4),
        "active_zcr": round(active_zcr, 4),
        "active_frame_ratio": round(active_frame_ratio, 3),
        "voiced_frame_ratio": round(voiced_frame_ratio, 3),
        "mean_voicing": round(mean_voicing, 3),
        "energy_variance": round(energy_variance, 4),
        "low_band_ratio": low_ratio,
        "speech_band_ratio": speech_ratio,
        "alarm_band_ratio": alarm_ratio,
        "high_band_ratio": high_ratio,
        "alarm_tonality": alarm_tonality,
        "alarm_dominance": alarm_dominance,
    }
