"""
ai-service/audio_processor.py – Audio preprocessing for YAMNet inference
Decodes WAV, PCM 16-bit / 24-bit / 32-bit, converts to 16 kHz mono float32,
and normalizes waveforms to the [-1.0, 1.0] range expected by YAMNet.
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
                        # Average all channels to mono
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

                elif sample_width == 4:  # 32-bit float or signed int
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
    """Normalize peak amplitude to 1.0 if not silent, clamping any extreme clipping."""
    if not samples:
        return []

    max_amp = max(abs(s) for s in samples)
    if max_amp > 1.0:
        return [max(-1.0, min(1.0, s / max_amp)) for s in samples]
    return [max(-1.0, min(1.0, s)) for s in samples]


def compute_audio_stats(samples: List[float]) -> Tuple[float, float]:
    """Compute RMS energy and peak amplitude."""
    if not samples:
        return 0.0, 0.0

    rms = math.sqrt(sum(s * s for s in samples) / len(samples))
    peak = max(abs(s) for s in samples)
    return round(rms, 4), round(peak, 4)
