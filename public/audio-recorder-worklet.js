/**
 * public/audio-recorder-worklet.js
 * EchoTrace AudioWorkletProcessor for low-latency background audio capture.
 * Converts multi-channel input to mono, computes volume metrics, and resamples
 * any browser hardware sample rate (e.g. 44.1kHz, 48kHz) to exactly 16 kHz.
 * Transmits complete 1.0-second float32 chunks (16,000 samples) via zero-copy MessagePort.
 */

class AudioRecorderWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.targetSampleRate = 16000;
    this.chunkDurationSec = 1.0;
    this.targetChunkSize = Math.floor(this.targetSampleRate * this.chunkDurationSec); // 16000 samples

    // Ratio of input sample rate to 16kHz
    // sampleRate is a global variable provided by AudioWorkletGlobalScope
    this.sourceSampleRate = typeof sampleRate !== 'undefined' ? sampleRate : 16000;
    this.resampleRatio = this.sourceSampleRate / this.targetSampleRate;
    this.resamplePhase = 0.0;
    this.lastInputSample = 0.0;

    // Buffer for 16kHz mono samples
    this.buffer = new Float32Array(this.targetChunkSize);
    this.bufferIndex = 0;

    this.isRecording = true;

    // Volume computation
    this.volumeAccumulator = 0;
    this.volumeSampleCount = 0;
    this.volumeReportInterval = Math.floor(this.sourceSampleRate / 25); // ~25 fps updates

    this.port.onmessage = this.handleMessage.bind(this);
  }

  handleMessage(event) {
    const data = event.data;
    if (!data) return;

    if (data.command === 'stop') {
      this.isRecording = false;
      this.bufferIndex = 0;
      this.resamplePhase = 0.0;
      this.volumeAccumulator = 0;
      this.volumeSampleCount = 0;
    } else if (data.command === 'start') {
      this.isRecording = true;
      this.bufferIndex = 0;
      this.resamplePhase = 0.0;
      this.volumeAccumulator = 0;
      this.volumeSampleCount = 0;
    } else if (data.command === 'reset') {
      this.bufferIndex = 0;
      this.resamplePhase = 0.0;
    }
  }

  process(inputs, outputs, parameters) {
    if (!this.isRecording) {
      return true;
    }

    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const numChannels = input.length;
    const frameCount = input[0].length; // Typically 128 frames per process call

    // Helper to get averaged mono sample at a given frame index
    const getMono = (idx) => {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        sum += input[ch][idx] || 0;
      }
      return sum / numChannels;
    };

    // 1. Calculate volume / signal energy for UI visual meter
    for (let i = 0; i < frameCount; i++) {
      const s = getMono(i);
      this.volumeAccumulator += s * s;
      this.volumeSampleCount++;
    }

    if (this.volumeSampleCount >= this.volumeReportInterval) {
      const rms = Math.sqrt(this.volumeAccumulator / this.volumeSampleCount);
      const level = Math.min(100, Math.round(rms * 350));
      this.port.postMessage({
        type: 'volume',
        level,
        sourceSampleRate: this.sourceSampleRate,
      });
      this.volumeAccumulator = 0;
      this.volumeSampleCount = 0;
    }

    // 2. Resample and buffer audio to 16 kHz mono
    if (Math.abs(this.sourceSampleRate - this.targetSampleRate) < 1) {
      // Direct copy when already 16,000 Hz
      for (let i = 0; i < frameCount; i++) {
        this.buffer[this.bufferIndex++] = getMono(i);
        if (this.bufferIndex >= this.targetChunkSize) {
          this.emitChunk();
        }
      }
    } else {
      // Linear interpolation resampling from sourceSampleRate to 16,000 Hz
      while (this.resamplePhase < frameCount) {
        const index0 = Math.floor(this.resamplePhase);
        const index1 = Math.min(index0 + 1, frameCount - 1);
        const frac = this.resamplePhase - index0;

        const s0 = getMono(index0);
        const s1 = getMono(index1);
        const interpolated = (1.0 - frac) * s0 + frac * s1;

        this.buffer[this.bufferIndex++] = interpolated;

        if (this.bufferIndex >= this.targetChunkSize) {
          this.emitChunk();
        }

        this.resamplePhase += this.resampleRatio;
      }
      this.resamplePhase -= frameCount;
    }

    return true;
  }

  emitChunk() {
    // Copy the filled buffer
    const chunk = new Float32Array(this.targetChunkSize);
    chunk.set(this.buffer);

    // Reset buffer pointer for next 1.0s window
    this.bufferIndex = 0;

    // Send zero-copy transferable Float32Array buffer to main thread
    this.port.postMessage(
      {
        type: 'chunk',
        samples: Array.from(chunk), // Array of floats ready for JSON transmission
        sampleRate: this.targetSampleRate,
        duration: this.chunkDurationSec,
      }
    );
  }
}

registerProcessor('audio-recorder-worklet', AudioRecorderWorkletProcessor);
