/**
 * src/utils/alertChime.ts
 * Configurable audible caregiver alert chime synthesized via Web Audio API.
 * Uses a non-intrusive harmonic two-tone bell sequence (E5 -> A5)
 * with an exponential decay volume envelope to avoid clicks or jarring noise.
 */

let chimeAudioCtx: AudioContext | null = null;

/**
 * Initializes and returns the AudioContext for alert chimes.
 * Created lazily after explicit user action to respect browser autoplay policies.
 */
function getChimeAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;

  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return null;

    if (!chimeAudioCtx || chimeAudioCtx.state === 'closed') {
      chimeAudioCtx = new AudioCtx();
    }

    if (chimeAudioCtx.state === 'suspended') {
      chimeAudioCtx.resume().catch(() => {});
    }

    return chimeAudioCtx;
  } catch (err) {
    console.warn('[EchoTrace] AudioContext creation failed for alert chime:', err);
    return null;
  }
}

/**
 * Synthesizes and plays a short, melodic, non-intrusive caregiver alert chime.
 * Tone sequence:
 * - Tone 1: E5 (659.25 Hz), duration 0.25s
 * - Tone 2: A5 (880.00 Hz), duration 0.40s
 * Total sound duration: ~0.55s.
 */
export function playAlertChime(): boolean {
  const ctx = getChimeAudioContext();
  if (!ctx) return false;

  try {
    const now = ctx.currentTime;

    const tones = [
      { freq: 659.25, start: 0.0, dur: 0.22, maxGain: 0.16 }, // E5
      { freq: 880.0, start: 0.14, dur: 0.42, maxGain: 0.20 }, // A5
    ];

    tones.forEach(({ freq, start, dur, maxGain }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + start);

      // Smooth attack ramp (15ms)
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(maxGain, now + start + 0.015);
      // Natural exponential decay
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + start);
      osc.stop(now + start + dur + 0.05);
    });

    return true;
  } catch (err) {
    console.warn('[EchoTrace] Alert chime playback error:', err);
    return false;
  }
}

/**
 * Unlocks the Web Audio context during user interaction so subsequent
 * background alert notifications can immediately play audio.
 */
export function unlockAudioContext(): void {
  const ctx = getChimeAudioContext();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}
