import { TARGET_CLASSES, CONFIDENCE_THRESHOLD, SAMPLE_RATE } from '../../src/config.ts';

export interface ClassificationPrediction {
  sound_class: string;
  confidence: number;
}

export interface ClassificationResult {
  detected: boolean;
  sound_class: string | null;
  confidence: number;
  duration: number;
  inference_engine: string;
  predictions: ClassificationPrediction[];
}

export function classifyWaveform(
  samples: number[],
  sampleRate: number = SAMPLE_RATE
): ClassificationResult {
  const n = samples.length;
  const duration = Math.round((n / sampleRate) * 100) / 100;

  if (n === 0 || duration < 0.15) {
    return {
      detected: false,
      sound_class: null,
      confidence: 0,
      duration,
      inference_engine: 'acoustic_spectral_engine',
      predictions: [],
    };
  }

  // Calculate RMS energy
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    sumSq += s * s;
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
  }
  const rms = Math.sqrt(sumSq / n);

  if (rms < 0.02) {
    // Room silence
    return {
      detected: false,
      sound_class: null,
      confidence: 0,
      duration,
      inference_engine: 'acoustic_spectral_engine',
      predictions: [],
    };
  }

  // Zero Crossing Rate (ZCR)
  let zeroCrossings = 0;
  for (let i = 1; i < n; i++) {
    if ((samples[i] >= 0 && samples[i - 1] < 0) || (samples[i] < 0 && samples[i - 1] >= 0)) {
      zeroCrossings++;
    }
  }
  const zcr = zeroCrossings / n;

  // Crest factor (peak to average ratio)
  const crest = peak / (rms + 1e-6);

  // Segment energy variance
  const numSubchunks = 8;
  const subchunkLen = Math.floor(n / numSubchunks);
  const subEnergies: number[] = [];
  for (let i = 0; i < numSubchunks; i++) {
    const start = i * subchunkLen;
    const end = start + subchunkLen;
    let subSum = 0;
    for (let j = start; j < end; j++) {
      subSum += samples[j] * samples[j];
    }
    subEnergies.push(Math.sqrt(subSum / subchunkLen));
  }

  const energyVariance =
    subEnergies.length > 0 ? Math.max(...subEnergies) - Math.min(...subEnergies) : 0;

  let detectedSound = 'Speech';
  let confidence = 0.72;

  if (zcr > 0.25 && crest > 3.5) {
    detectedSound = 'Keys jingling';
    confidence = 0.88;
  } else if (zcr > 0.22 && energyVariance > 0.08) {
    detectedSound = 'Dishes, pots, and pans';
    confidence = 0.85;
  } else if (zcr < 0.08 && crest > 3.0) {
    detectedSound = duration < 1.2 ? 'Knock' : 'Door';
    confidence = 0.86;
  } else if (zcr < 0.12 && energyVariance > 0.04) {
    detectedSound = 'Footsteps';
    confidence = 0.78;
  } else if (zcr >= 0.12 && zcr <= 0.22 && energyVariance < 0.03 && rms > 0.04) {
    detectedSound = 'Water tap, faucet';
    confidence = 0.84;
  } else if (zcr >= 0.09 && zcr <= 0.18) {
    detectedSound = 'Speech';
    confidence = 0.82;
  } else {
    detectedSound = 'Drawer';
    confidence = 0.71;
  }

  const predictions: ClassificationPrediction[] = [
    { sound_class: detectedSound, confidence },
    {
      sound_class: detectedSound !== 'Footsteps' ? 'Footsteps' : 'Speech',
      confidence: Math.round(confidence * 0.6 * 100) / 100,
    },
    {
      sound_class:
        detectedSound !== 'Water tap, faucet' ? 'Water tap, faucet' : 'Dishes, pots, and pans',
      confidence: Math.round(confidence * 0.4 * 100) / 100,
    },
  ];

  if (confidence < CONFIDENCE_THRESHOLD) {
    return {
      detected: false,
      sound_class: null,
      confidence: 0,
      duration,
      inference_engine: 'acoustic_spectral_engine',
      predictions,
    };
  }

  return {
    detected: true,
    sound_class: detectedSound,
    confidence: Math.round(confidence * 1000) / 1000,
    duration,
    inference_engine: 'acoustic_spectral_engine',
    predictions,
  };
}

export function decodeBase64ToSamples(base64Str: string): number[] {
  try {
    const buffer = Buffer.from(base64Str, 'base64');
    // Check if WAV header exists ('RIFF')
    if (buffer.length >= 44 && buffer.toString('ascii', 0, 4) === 'RIFF') {
      // 16-bit PCM WAV starting at byte 44
      const samples: number[] = [];
      for (let i = 44; i < buffer.length - 1; i += 2) {
        const int16 = buffer.readInt16LE(i);
        samples.push(int16 / 32768.0);
      }
      return samples;
    }

    // Raw 16-bit PCM
    const samples: number[] = [];
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const int16 = buffer.readInt16LE(i);
      samples.push(int16 / 32768.0);
    }
    return samples;
  } catch {
    return [];
  }
}
