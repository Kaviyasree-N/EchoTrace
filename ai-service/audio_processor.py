"""
ai-service/audio_processor.py – Audio preprocessing for YAMNet inference
"""

import io
import math
import wave
from typing import List, Tuple

from config import SAMPLE_RATE


def decode_audio_payload(data: bytes, content_type: str = "") -> List[float]:
    """
    Decodes audio bytes into a 16 kHz mono float32 waveform list in range [-1.0, 1.0].
    Supports WAV format, raw PCM 16-bit, or raw float32.
    """
    if not data:
        return []

    # Check if WAV format
    if data.startswith(b"RIFF") and b"WAVE" in data[:12]:
        try:
            with wave.open(io.BytesIO(data), "rb") as wav_file:
                channels = wav_file.getnchannels()
                sample_width = wav_file.getsampwidth()
                framerate = wav_file.getframerate()
                n_frames = wav_file.getnframes()
                raw_bytes = wav_file.readframes(n_frames)

                samples = []
                if sample_width == 2:  # 16-bit PCM
                    step = 2 * channels
                    for i in range(0, len(raw_bytes), step):
                        # Take channel 0
                        val = int.from_bytes(raw_bytes[i:i+2], byteorder="little", signed=True)
                        samples.append(val / 32768.0)
                elif sample_width == 1:  # 8-bit PCM
                    step = channels
                    for i in range(0, len(raw_bytes), step):
                        val = raw_bytes[i] - 128
                        samples.append(val / 128.0)
                else:
                    return []

                # Resample if not 16 kHz
                if framerate != SAMPLE_RATE and framerate > 0 and len(samples) > 0:
                    samples = resample_linear(samples, framerate, SAMPLE_RATE)

                return normalize_waveform(samples)
        except Exception as e:
            # Fall back to raw PCM handling
            pass

    # Treat as raw 16-bit signed PCM mono at 16kHz
    samples = []
    for i in range(0, len(data) - 1, 2):
        val = int.from_bytes(data[i:i+2], byteorder="little", signed=True)
        samples.append(val / 32768.0)

    return normalize_waveform(samples)


def resample_linear(samples: List[float], orig_sr: int, target_sr: int) -> List[float]:
    """Simple high-performance linear resampler for mono float lists."""
    if orig_sr == target_sr or not samples:
        return samples

    ratio = orig_sr / target_sr
    new_len = int(len(samples) / ratio)
    output = [0.0] * new_len

    for i in range(new_len):
        src_idx = i * ratio
        idx0 = int(src_idx)
        idx1 = min(idx0 + 1, len(samples) - 1)
        frac = src_idx - idx0
        output[i] = (1.0 - frac) * samples[idx0] + frac * samples[idx1]

    return output


def normalize_waveform(samples: List[float]) -> List[float]:
    """Normalize peak amplitude to 1.0 if not silent."""
    if not samples:
        return []

    max_amp = max(abs(s) for s in samples)
    if max_amp > 1.0:
        return [s / max_amp for s in samples]
    return samples


def compute_audio_stats(samples: List[float]) -> Tuple[float, float]:
    """Compute RMS energy and peak amplitude."""
    if not samples:
        return 0.0, 0.0

    rms = math.sqrt(sum(s * s for s in samples) / len(samples))
    peak = max(abs(s) for s in samples)
    return rms, peak
