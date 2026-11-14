import { CONFIDENCE_THRESHOLD, SAMPLE_RATE } from '../../src/config.ts';

export interface ClassificationPrediction {
  sound_class: string;
  confidence: number;
}

export interface VadSummary {
  is_speech_active: boolean;
  speech_probability: number;
}

export interface ClassificationResult {
  detected: boolean;
  sound_class: string | null;
  confidence: number;
  duration: number;
  inference_engine: string;
  predictions: ClassificationPrediction[];
  vad?: VadSummary;
  smoothed?: boolean;
}

export interface ClassifyOptions {
  clientSessionId?: string | null;
  confidenceThreshold?: number;
  bypassSmoothing?: boolean;
}

interface VadFeatures {
  isSpeechActive: boolean;
  speechProbability: number;
  isSilent: boolean;
  isImpulsive: boolean;
  rms: number;
  peak: number;
  crest: number;
  zcr: number;
  activeZcr: number;
  activeFrameRatio: number;
  voicedFrameRatio: number;
  meanVoicing: number;
  energyVariance: number;
  lowBandRatio: number;
  speechBandRatio: number;
  alarmBandRatio: number;
  highBandRatio: number;
  alarmTonality: number;
  alarmDominance: number;
}

const CRITICAL_CLASSES = new Set([
  'Smoke detector, smoke alarm',
  'Fire alarm',
  'Glass breaking',
  'Loud impacts',
  'Crying, sobbing',
]);

const SPEECH_CLASSES = new Set(['Speech', 'Conversation']);

const CLASS_TO_CATEGORY: Record<string, string> = {
  'Smoke detector, smoke alarm': 'critical',
  'Fire alarm': 'critical',
  'Glass breaking': 'critical',
  'Crying, sobbing': 'critical',
  'Loud impacts': 'impact',
  Speech: 'speech',
  Conversation: 'speech',
  Footsteps: 'footsteps',
};

const CATEGORY_THRESHOLDS: Record<string, number> = {
  critical: 0.30,
  impact: 0.48,
  speech: 0.34,
  footsteps: 0.58,
  default: CONFIDENCE_THRESHOLD,
};

function getEffectiveThreshold(soundClass: string, baseThreshold?: number): number {
  const base =
    baseThreshold !== undefined && !Number.isNaN(baseThreshold)
      ? Math.max(0.05, Math.min(0.95, baseThreshold))
      : CONFIDENCE_THRESHOLD;
  const category = CLASS_TO_CATEGORY[soundClass] || 'default';
  const catDefault = CATEGORY_THRESHOLDS[category] ?? CONFIDENCE_THRESHOLD;
  const delta = base - CONFIDENCE_THRESHOLD;

  if (category === 'critical') {
    return Math.round(Math.max(0.25, Math.min(0.75, catDefault + delta * 0.5)) * 1000) / 1000;
  }
  if (category === 'footsteps') {
    return Math.round(Math.max(0.50, Math.min(0.95, catDefault + delta)) * 1000) / 1000;
  }
  if (category === 'speech') {
    return Math.round(Math.max(0.25, Math.min(0.90, catDefault + delta)) * 1000) / 1000;
  }
  if (category === 'impact') {
    return Math.round(Math.max(0.38, Math.min(0.92, catDefault + delta)) * 1000) / 1000;
  }
  return Math.round(base * 1000) / 1000;
}

interface SessionTemporalState {
  lastSeenMs: number;
  emaScores: Record<string, number>;
  consecutive: Record<string, number>;
}

const TEMPORAL_TTL_MS = 8000;
const EMA_ALPHA = 0.55;
const FOOTSTEPS_CONFIRMATION_CHUNKS = 2;
const FOOTSTEPS_HIGH_CONF_BYPASS = 0.90;
const sessionStates = new Map<string, SessionTemporalState>();

export function resetAcousticTemporalState(sessionId?: string): void {
  if (sessionId) {
    sessionStates.delete(sessionId);
  } else {
    sessionStates.clear();
  }
}

function preprocessWaveform(samples: number[], sampleRate: number): number[] {
  const n = samples.length;
  if (n === 0) return [];

  // 1. DC offset removal
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i];
  const mean = sum / n;

  // 2. First-order 75 Hz high-pass filter
  const cutoffHz = 75;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / Math.max(1, sampleRate);
  const alpha = rc / (rc + dt);

  const out = new Array<number>(n);
  let prevX = samples[0] - mean;
  let prevY = 0;
  let maxAmp = 0;
  for (let i = 0; i < n; i++) {
    const x = samples[i] - mean;
    const y = alpha * (prevY + x - prevX);
    out[i] = y;
    prevX = x;
    prevY = y;
    const abs = Math.abs(y);
    if (abs > maxAmp) maxAmp = abs;
  }

  if (maxAmp > 1.0) {
    for (let i = 0; i < n; i++) {
      out[i] = Math.max(-1, Math.min(1, out[i] / maxAmp));
    }
  }
  return out;
}

const FFT_N = 256;
const HANN_256: number[] = Array.from({ length: FFT_N }, (_, i) =>
  0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_N - 1)))
);

function fftPowerSpectrum256(frame: number[]): number[] {
  const n = FFT_N;
  const real = new Array<number>(n).fill(0);
  const imag = new Array<number>(n).fill(0);

  if (frame.length >= n) {
    const offset = Math.floor((frame.length - n) / 2);
    for (let i = 0; i < n; i++) {
      real[i] = frame[offset + i] * HANN_256[i];
    }
  } else {
    for (let i = 0; i < frame.length; i++) {
      real[i] = frame[i] * HANN_256[i];
    }
  }

  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
  }

  for (let length = 2; length <= n; length <<= 1) {
    const half = length >> 1;
    const angleStep = (-2 * Math.PI) / length;
    const wStepR = Math.cos(angleStep);
    const wStepI = Math.sin(angleStep);
    for (let start = 0; start < n; start += length) {
      let wR = 1;
      let wI = 0;
      for (let k = 0; k < half; k++) {
        const evenIdx = start + k;
        const oddIdx = evenIdx + half;
        const tR = wR * real[oddIdx] - wI * imag[oddIdx];
        const tI = wR * imag[oddIdx] + wI * real[oddIdx];
        const uR = real[evenIdx];
        const uI = imag[evenIdx];
        real[evenIdx] = uR + tR;
        imag[evenIdx] = uI + tI;
        real[oddIdx] = uR - tR;
        imag[oddIdx] = uI - tI;
        const nextWR = wR * wStepR - wI * wStepI;
        wI = wR * wStepI + wI * wStepR;
        wR = nextWR;
      }
    }
  }

  const halfN = n / 2 + 1;
  const spec = new Array<number>(halfN);
  for (let k = 0; k < halfN; k++) {
    spec[k] = real[k] * real[k] + imag[k] * imag[k];
  }
  return spec;
}

function frameVoicingScore(frame: number[], sampleRate: number): number {
  const n = frame.length;
  if (n < 120) return 0;
  const minLag = Math.max(20, Math.floor(sampleRate / 380));
  const maxLag = Math.min(Math.floor(n / 2), Math.floor(sampleRate / 75));
  if (maxLag <= minLag) return 0;

  let energy = 0;
  for (let i = 0; i < n; i++) energy += frame[i] * frame[i];
  if (energy < 1e-8) return 0;

  let bestCorr = 0;
  for (let lag = minLag; lag < maxLag; lag += 2) {
    const limit = n - lag;
    let num = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i < limit; i++) {
      const a = frame[i];
      const b = frame[i + lag];
      num += a * b;
      e1 += a * a;
      e2 += b * b;
    }
    const corr = num / (Math.sqrt(e1 * e2) + 1e-9);
    if (corr > bestCorr) bestCorr = corr;
  }
  return Math.max(0, Math.min(1, bestCorr));
}

function analyzeVoiceActivity(samples: number[], sampleRate: number): VadFeatures {
  const n = samples.length;
  if (n === 0) {
    return {
      isSpeechActive: false,
      speechProbability: 0,
      isSilent: true,
      isImpulsive: false,
      rms: 0,
      peak: 0,
      crest: 0,
      zcr: 0,
      activeZcr: 0,
      activeFrameRatio: 0,
      voicedFrameRatio: 0,
      meanVoicing: 0,
      energyVariance: 0,
      lowBandRatio: 0,
      speechBandRatio: 0,
      alarmBandRatio: 0,
      highBandRatio: 0,
      alarmTonality: 0,
      alarmDominance: 0,
    };
  }

  let sumSq = 0;
  let peak = 0;
  let zeroCrossings = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    sumSq += s * s;
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
    if (i > 0 && ((s >= 0 && samples[i - 1] < 0) || (s < 0 && samples[i - 1] >= 0))) {
      zeroCrossings++;
    }
  }

  const rms = Math.sqrt(sumSq / n);
  const crest = peak / (rms + 1e-6);
  const zcr = zeroCrossings / n;

  if (rms < 0.015) {
    return {
      isSpeechActive: false,
      speechProbability: 0,
      isSilent: true,
      isImpulsive: false,
      rms,
      peak,
      crest,
      zcr,
      activeZcr: 0,
      activeFrameRatio: 0,
      voicedFrameRatio: 0,
      meanVoicing: 0,
      energyVariance: 0,
      lowBandRatio: 0,
      speechBandRatio: 0,
      alarmBandRatio: 0,
      highBandRatio: 0,
      alarmTonality: 0,
      alarmDominance: 0,
    };
  }

  const frameLen = Math.max(160, Math.floor(sampleRate * 0.02));
  const frames: number[][] = [];
  const frameRms: number[] = [];

  for (let start = 0; start + frameLen <= n; start += frameLen) {
    const fr = samples.slice(start, start + frameLen);
    let frSq = 0;
    for (let j = 0; j < frameLen; j++) frSq += fr[j] * fr[j];
    frames.push(fr);
    frameRms.push(Math.sqrt(frSq / frameLen));
  }

  if (frames.length === 0) {
    frames.push(samples);
    frameRms.push(rms);
  }

  const sortedRms = [...frameRms].sort((a, b) => a - b);
  const noiseFloor = sortedRms[Math.floor(sortedRms.length / 5)] ?? 0;
  const activeThresh = Math.max(0.012, noiseFloor * 1.8, rms * 0.35);

  const activeFrames: number[][] = [];
  for (let i = 0; i < frames.length; i++) {
    if (frameRms[i] >= activeThresh) {
      activeFrames.push(frames[i]);
    }
  }

  const activeFrameRatio = activeFrames.length / frames.length;

  // Sub-chunk energy variance (8 chunks)
  const numSubchunks = 8;
  const subLen = Math.max(1, Math.floor(n / numSubchunks));
  const subEnergies: number[] = [];
  for (let i = 0; i < numSubchunks; i++) {
    const start = i * subLen;
    const end = Math.min(n, start + subLen);
    if (end > start) {
      let subSq = 0;
      for (let j = start; j < end; j++) subSq += samples[j] * samples[j];
      subEnergies.push(Math.sqrt(subSq / (end - start)));
    }
  }
  const energyVariance =
    subEnergies.length > 0 ? Math.max(...subEnergies) - Math.min(...subEnergies) : 0;

  // Sample up to 10 active frames for voicing & spectral bands
  const targetSampled = activeFrames.length > 0 ? activeFrames : frames.slice(0, 4);
  const step = Math.max(1, Math.floor(targetSampled.length / 10));
  const sampled: number[][] = [];
  for (let i = 0; i < targetSampled.length && sampled.length < 10; i += step) {
    sampled.push(targetSampled[i]);
  }

  let voicedCount = 0;
  let voicingSum = 0;
  let activeZcTotal = 0;
  let activeSampleTotal = 0;
  for (const fr of sampled) {
    const v = frameVoicingScore(fr, sampleRate);
    voicingSum += v;
    if (v >= 0.42) voicedCount++;
    activeSampleTotal += fr.length;
    for (let idx = 1; idx < fr.length; idx++) {
      if ((fr[idx] >= 0 && fr[idx - 1] < 0) || (fr[idx] < 0 && fr[idx - 1] >= 0)) {
        activeZcTotal++;
      }
    }
  }

  const activeZcr = activeSampleTotal > 0 ? activeZcTotal / activeSampleTotal : zcr;
  const voicedFrameRatio = sampled.length > 0 ? voicedCount / sampled.length : 0;
  const meanVoicing = sampled.length > 0 ? voicingSum / sampled.length : 0;

  // Band power profile via 256-point Hann-windowed FFT
  const halfN = FFT_N / 2 + 1;
  const meanSpec = new Array<number>(halfN).fill(0);
  for (const fr of sampled) {
    const spec = fftPowerSpectrum256(fr);
    for (let k = 0; k < halfN; k++) {
      meanSpec[k] += spec[k];
    }
  }

  const invCount = 1 / Math.max(1, sampled.length);
  const df = sampleRate / FFT_N;

  let totalPower = 1e-12;
  let lowPower = 0;
  let speechPower = 0;
  let alarmPower = 0;
  let alarmPeak = 0;
  let highPower = 0;

  for (let k = 1; k < halfN; k++) {
    const freq = k * df;
    const p = meanSpec[k] * invCount;
    if (freq >= 70 && freq <= 7500) totalPower += p;
    if (freq >= 70 && freq <= 255) lowPower += p;
    if (freq >= 300 && freq <= 3400) speechPower += p;
    if (freq >= 2700 && freq <= 3550) {
      alarmPower += p;
      if (p > alarmPeak) alarmPeak = p;
    }
    if (freq >= 2500 && freq <= 7500) highPower += p;
  }

  const lowBandRatio = lowPower / totalPower;
  const speechBandRatio = speechPower / totalPower;
  const alarmBandRatio = alarmPower / totalPower;
  const highBandRatio = highPower / totalPower;
  const alarmTonality = alarmPeak / (alarmPower + 1e-12);
  const alarmDominance = alarmPower / (highPower + 1e-12);

  const medianFrameRms = (sortedRms[Math.floor(sortedRms.length / 2)] ?? 0) + 1e-6;
  const maxFrameRms = sortedRms[sortedRms.length - 1] ?? 0;
  const peakToMedianFrame = maxFrameRms / medianFrameRms;
  const isImpulsive =
    (crest >= 3.4 && activeFrameRatio <= 0.48) ||
    (peakToMedianFrame >= 4.2 && activeFrameRatio <= 0.42);

  let speechScore = 0;
  const hasSpeechFormants = speechBandRatio >= 0.28 && speechBandRatio >= lowBandRatio * 0.65;
  if (hasSpeechFormants) {
    if (meanVoicing >= 0.45) speechScore += 0.35;
    else if (meanVoicing >= 0.32) speechScore += 0.18;

    if (voicedFrameRatio >= 0.4) speechScore += 0.2;
    else if (voicedFrameRatio >= 0.2) speechScore += 0.1;
  }

  if (speechBandRatio >= 0.48 && speechBandRatio > lowBandRatio * 1.25) speechScore += 0.25;
  else if (speechBandRatio >= 0.35 && speechBandRatio > lowBandRatio) speechScore += 0.12;

  if (activeFrameRatio >= 0.25 && activeFrameRatio <= 0.96) speechScore += 0.15;
  if (activeZcr >= 0.03 && activeZcr <= 0.24) speechScore += 0.1;

  if (alarmBandRatio >= 0.5 && alarmTonality >= 0.35 && alarmDominance >= 0.6) speechScore -= 0.45;
  if ((highBandRatio >= 0.55 && activeZcr > 0.24) || (isImpulsive && highBandRatio >= 0.38)) {
    speechScore -= 0.4;
  }
  if (lowBandRatio > 0.52 && speechBandRatio < 0.35) speechScore -= 0.35;

  const speechProbability = Math.round(Math.max(0, Math.min(1, speechScore)) * 1000) / 1000;
  const isSpeechActive = speechProbability >= 0.52;

  return {
    isSpeechActive,
    speechProbability,
    isSilent: false,
    isImpulsive,
    rms,
    peak,
    crest,
    zcr,
    activeZcr,
    activeFrameRatio,
    voicedFrameRatio,
    meanVoicing,
    energyVariance,
    lowBandRatio,
    speechBandRatio,
    alarmBandRatio,
    highBandRatio,
    alarmTonality,
    alarmDominance,
  };
}

function evaluateTemporalSmoothing(
  sessionId: string | null | undefined,
  rawScores: Record<string, number>,
  vad: VadFeatures,
  baseThreshold?: number,
  bypassSmoothing: boolean = false
): { selectedClass: string | null; confidence: number; smoothed: boolean } {
  const now = Date.now();
  const key = (sessionId || 'default').trim() || 'default';

  for (const [sid, st] of sessionStates.entries()) {
    if (now - st.lastSeenMs > TEMPORAL_TTL_MS) {
      sessionStates.delete(sid);
    }
  }

  let state = sessionStates.get(key);
  if (!state) {
    state = { lastSeenMs: now, emaScores: {}, consecutive: {} };
    sessionStates.set(key, state);
  } else {
    state.lastSeenMs = now;
  }

  // 1. Critical emergency sounds fire immediately without multi-chunk delay
  const criticalPriority = [
    'Smoke detector, smoke alarm',
    'Fire alarm',
    'Glass breaking',
    'Loud impacts',
    'Crying, sobbing',
  ];
  for (const crit of criticalPriority) {
    const score = rawScores[crit] ?? 0;
    const thresh = getEffectiveThreshold(crit, baseThreshold);
    if (score >= thresh) {
      state.emaScores[crit] = score;
      state.consecutive[crit] = (state.consecutive[crit] || 0) + 1;
      return { selectedClass: crit, confidence: Math.round(score * 1000) / 1000, smoothed: false };
    }
  }

  // 2. EMA update
  const allKeys = new Set([...Object.keys(state.emaScores), ...Object.keys(rawScores)]);
  const newEma: Record<string, number> = {};
  for (const cls of allKeys) {
    const curr = rawScores[cls] ?? 0;
    const prev = state.emaScores[cls] ?? 0;
    const val =
      bypassSmoothing || Object.keys(state.emaScores).length === 0
        ? curr
        : EMA_ALPHA * curr + (1 - EMA_ALPHA) * prev;
    if (val >= 0.01) {
      newEma[cls] = Math.round(val * 10000) / 10000;
    }
  }
  state.emaScores = newEma;

  // 3. VAD speech-priority disambiguation
  const adjusted = { ...newEma };
  const rawSpeech = Math.max(rawScores.Speech ?? 0, rawScores.Conversation ?? 0);
  const rawFootsteps = rawScores.Footsteps ?? 0;

  if (vad.isSpeechActive || (vad.speechProbability >= 0.45 && vad.voicedFrameRatio >= 0.3)) {
    if (adjusted.Footsteps !== undefined) {
      const unambiguousFootsteps =
        rawFootsteps >= 0.75 &&
        vad.lowBandRatio > vad.speechBandRatio * 1.15 &&
        rawFootsteps > rawSpeech + 0.25;
      if (!unambiguousFootsteps) {
        adjusted.Footsteps = adjusted.Footsteps * 0.35;
      }
    }
  }

  const candidates = Object.entries(adjusted)
    .filter(([cls, score]) => score >= getEffectiveThreshold(cls, baseThreshold))
    .sort((a, b) => b[1] - a[1]);

  if (candidates.length === 0) {
    for (const k of Object.keys(state.consecutive)) state.consecutive[k] = 0;
    return { selectedClass: null, confidence: 0, smoothed: !bypassSmoothing };
  }

  const [topCls, topScore] = candidates[0];
  for (const k of Object.keys(state.consecutive)) {
    if (k !== topCls) state.consecutive[k] = 0;
  }
  state.consecutive[topCls] = (state.consecutive[topCls] || 0) + 1;

  if (topCls === 'Footsteps' && !bypassSmoothing) {
    const confirmedByChunks = state.consecutive.Footsteps >= FOOTSTEPS_CONFIRMATION_CHUNKS;
    const confirmedByHighConf =
      rawFootsteps >= FOOTSTEPS_HIGH_CONF_BYPASS && !vad.isSpeechActive && vad.speechProbability < 0.35;
    if (!confirmedByChunks && !confirmedByHighConf) {
      for (const [secCls, secScore] of candidates.slice(1)) {
        if (SPEECH_CLASSES.has(secCls) && vad.isSpeechActive) {
          return {
            selectedClass: secCls,
            confidence: Math.round(secScore * 1000) / 1000,
            smoothed: true,
          };
        }
      }
      return { selectedClass: null, confidence: 0, smoothed: true };
    }
  }

  return {
    selectedClass: topCls,
    confidence: Math.round(topScore * 1000) / 1000,
    smoothed: !bypassSmoothing,
  };
}

export function classifyWaveform(
  samples: number[],
  sampleRate: number = SAMPLE_RATE,
  options: ClassifyOptions = {}
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

  const cleaned = preprocessWaveform(samples, sampleRate);
  const vad = analyzeVoiceActivity(cleaned, sampleRate);

  if (vad.isSilent) {
    return {
      detected: false,
      sound_class: null,
      confidence: 0,
      duration,
      inference_engine: 'acoustic_spectral_engine',
      predictions: [],
      vad: { is_speech_active: false, speech_probability: 0 },
    };
  }

  const candidateScores: Record<string, number> = {};

  // 1. Critical: Smoke detector / Fire alarm
  if (
    vad.alarmBandRatio >= 0.5 &&
    vad.alarmTonality >= 0.35 &&
    vad.alarmDominance >= 0.6 &&
    vad.rms >= 0.03 &&
    !(vad.isImpulsive && vad.crest >= 3.4)
  ) {
    const score = Math.min(0.96, 0.55 + vad.alarmBandRatio * 0.25 + vad.alarmTonality * 0.2);
    candidateScores['Smoke detector, smoke alarm'] = Math.round(score * 1000) / 1000;
  }

  // 2. Critical: Glass breaking
  if (vad.highBandRatio >= 0.42 && vad.activeZcr >= 0.23 && vad.crest >= 3.3 && !vad.isSpeechActive) {
    const score = Math.min(
      0.94,
      0.48 + vad.highBandRatio * 0.3 + Math.min(0.2, (vad.crest - 3.0) * 0.08)
    );
    candidateScores['Glass breaking'] = Math.round(score * 1000) / 1000;
  }

  // 3. Speech (high priority via VAD voicing + speech-band dominance)
  if (
    vad.isSpeechActive ||
    (vad.meanVoicing >= 0.38 && vad.speechBandRatio >= 0.42 && vad.activeZcr >= 0.03 && vad.activeZcr <= 0.23)
  ) {
    const speechConf = Math.min(
      0.94,
      0.46 + vad.speechProbability * 0.36 + vad.voicedFrameRatio * 0.12
    );
    candidateScores.Speech = Math.round(speechConf * 1000) / 1000;
  }

  // 4. Keys jingling / Dishes
  if (
    vad.activeZcr > 0.25 &&
    vad.crest > 3.5 &&
    vad.alarmTonality < 0.35 &&
    !vad.isSpeechActive &&
    !candidateScores['Glass breaking']
  ) {
    candidateScores['Keys jingling'] = 0.84;
  } else if (
    vad.activeZcr > 0.22 &&
    vad.energyVariance > 0.06 &&
    vad.highBandRatio >= 0.3 &&
    !vad.isSpeechActive &&
    !candidateScores['Glass breaking']
  ) {
    candidateScores['Dishes, pots, and pans'] = 0.82;
  }

  // 5. Knock / Door
  if (
    vad.isImpulsive &&
    vad.activeZcr < 0.1 &&
    vad.crest > 3.3 &&
    vad.voicedFrameRatio < 0.2 &&
    !vad.isSpeechActive
  ) {
    candidateScores[duration < 1.2 ? 'Knock' : 'Door'] = 0.82;
  }

  // 6. Footsteps (strictly low-band impulsive bursts with quiet gaps, non-voiced)
  if (
    vad.lowBandRatio >= 0.45 &&
    vad.lowBandRatio > vad.speechBandRatio &&
    vad.activeZcr < 0.12 &&
    vad.energyVariance > 0.035 &&
    vad.activeFrameRatio <= 0.5 &&
    (vad.voicedFrameRatio < 0.2 || (vad.lowBandRatio >= 0.55 && vad.speechBandRatio < 0.3)) &&
    vad.speechProbability < 0.35
  ) {
    const footConf = Math.min(
      0.86,
      0.52 + vad.lowBandRatio * 0.28 + (vad.isImpulsive ? 0.1 : 0)
    );
    candidateScores.Footsteps = Math.round(footConf * 1000) / 1000;
  }

  // 7. Water tap, faucet
  if (
    vad.activeZcr >= 0.12 &&
    vad.activeZcr <= 0.24 &&
    vad.energyVariance < 0.035 &&
    vad.rms > 0.04 &&
    vad.voicedFrameRatio < 0.25 &&
    !vad.isSpeechActive
  ) {
    candidateScores['Water tap, faucet'] = 0.8;
  }

  if (Object.keys(candidateScores).length === 0) {
    const fallbackLabel =
      vad.speechProbability >= 0.3
        ? 'Speech'
        : vad.isImpulsive
        ? 'Loud impacts'
        : 'Water tap, faucet';
    const fallbackConf = Math.round(Math.max(0.12, Math.min(0.32, vad.rms * 0.8)) * 1000) / 1000;
    return {
      detected: false,
      sound_class: null,
      confidence: 0,
      duration,
      inference_engine: 'acoustic_spectral_engine',
      predictions: [{ sound_class: fallbackLabel, confidence: fallbackConf }],
      vad: {
        is_speech_active: vad.isSpeechActive,
        speech_probability: vad.speechProbability,
      },
      smoothed: false,
    };
  }

  const predictions: ClassificationPrediction[] = Object.entries(candidateScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([sound_class, confidence]) => ({ sound_class, confidence }));

  const decision = evaluateTemporalSmoothing(
    options.clientSessionId,
    candidateScores,
    vad,
    options.confidenceThreshold,
    Boolean(options.bypassSmoothing)
  );

  if (!decision.selectedClass) {
    return {
      detected: false,
      sound_class: null,
      confidence: 0,
      duration,
      inference_engine: 'acoustic_spectral_engine',
      predictions,
      vad: {
        is_speech_active: vad.isSpeechActive,
        speech_probability: vad.speechProbability,
      },
      smoothed: decision.smoothed,
    };
  }

  return {
    detected: true,
    sound_class: decision.selectedClass,
    confidence: decision.confidence,
    duration,
    inference_engine: 'acoustic_spectral_engine',
    predictions,
    vad: {
      is_speech_active: vad.isSpeechActive,
      speech_probability: vad.speechProbability,
    },
    smoothed: decision.smoothed,
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
