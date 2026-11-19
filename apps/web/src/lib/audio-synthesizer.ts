/**
 * Web Audio API Synthesizer Helper
 * Generates custom synthesized chimes and tones without any external MP3/audio files.
 * Provides envelope shaping (ADSR), multi-frequency sequences, and screen flash hooks.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type OscillatorWaveform = 'sine' | 'triangle' | 'square' | 'sawtooth';

export interface SoundProfile {
  severity: AlertSeverity;
  name: string;
  waveform: OscillatorWaveform;
  frequencies: number[]; // Frequencies in Hertz (Hz)
  duration: number; // Duration of each tone in seconds
  interval: number; // Interval between consecutive tones in seconds
  volume: number; // Volume percentage (0 - 100)
  attackTime: number; // Envelope attack in seconds
  decayTime: number; // Envelope decay in seconds
  flashScreen: boolean;
  flashColor: string; // CSS color string (e.g. rgba(6,182,212,0.3))
  flashDurationMs: number;
}

export const DEFAULT_SOUND_PROFILES: Record<AlertSeverity, SoundProfile> = {
  info: {
    severity: 'info',
    name: 'Mellow Chime',
    waveform: 'sine',
    frequencies: [523.25, 659.25, 783.99], // C5, E5, G5 major triad
    duration: 0.25,
    interval: 0.08,
    volume: 70,
    attackTime: 0.01,
    decayTime: 0.3,
    flashScreen: true,
    flashColor: 'rgba(6, 182, 212, 0.25)', // Cyan
    flashDurationMs: 400,
  },
  warning: {
    severity: 'warning',
    name: 'Attention Alert',
    waveform: 'triangle',
    frequencies: [440.0, 554.37, 659.25, 880.0], // A4, C#5, E5, A5
    duration: 0.18,
    interval: 0.06,
    volume: 85,
    attackTime: 0.005,
    decayTime: 0.25,
    flashScreen: true,
    flashColor: 'rgba(245, 158, 11, 0.3)', // Amber
    flashDurationMs: 500,
  },
  critical: {
    severity: 'critical',
    name: 'Emergency Siren Pulse',
    waveform: 'square',
    frequencies: [880.0, 1174.66, 880.0, 1174.66], // High A5 to D6 alarm pulse
    duration: 0.15,
    interval: 0.05,
    volume: 100,
    attackTime: 0.002,
    decayTime: 0.2,
    flashScreen: true,
    flashColor: 'rgba(239, 68, 68, 0.4)', // Red
    flashDurationMs: 700,
  },
};

let audioContextInstance: AudioContext | null = null;

export function getOrCreateAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;

  try {
    if (!audioContextInstance || audioContextInstance.state === 'closed') {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      audioContextInstance = new AudioCtx();
    }
    return audioContextInstance;
  } catch (err) {
    console.warn('[audio-synthesizer] AudioContext creation failed:', err);
    return null;
  }
}

/**
 * Resumes the AudioContext if suspended (requires user gesture)
 */
export async function unlockAudioContext(): Promise<boolean> {
  const ctx = getOrCreateAudioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
      return ctx.state === 'running';
    } catch {
      return false;
    }
  }
  return ctx.state === 'running';
}

/**
 * Synthesizes a tone sequence for a given sound profile using Web Audio API
 */
export async function playSoundProfile(
  profile: SoundProfile,
  masterVolumePercent = 100
): Promise<void> {
  const ctx = getOrCreateAudioContext();
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      return;
    }
  }

  if (ctx.state !== 'running') return;

  const now = ctx.currentTime;
  const masterGain = Math.max(0.0001, (profile.volume / 100) * (masterVolumePercent / 100) * 0.3);

  // Play each note in the frequency array with timing offsets
  profile.frequencies.forEach((freq, idx) => {
    const noteStartTime = now + idx * profile.interval;
    const noteDuration = profile.duration;

    const osc = ctx.createOscillator();
    const noteGain = ctx.createGain();

    osc.type = profile.waveform;
    osc.frequency.setValueAtTime(freq, noteStartTime);

    // Envelope shaping (Attack -> Decay)
    noteGain.gain.setValueAtTime(0.0001, noteStartTime);
    noteGain.gain.exponentialRampToValueAtTime(masterGain, noteStartTime + profile.attackTime);
    noteGain.gain.exponentialRampToValueAtTime(
      0.0001,
      noteStartTime + profile.attackTime + profile.decayTime
    );

    osc.connect(noteGain);
    noteGain.connect(ctx.destination);

    osc.start(noteStartTime);
    osc.stop(noteStartTime + noteDuration + profile.decayTime);
  });

  const totalDuration = profile.frequencies.length * profile.interval + profile.duration + profile.decayTime;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.round(totalDuration * 1000));
  });
}

/**
 * Trigger DOM visual screen flash animation
 */
export function triggerScreenFlash(color: string, durationMs: number): void {
  if (typeof document === 'undefined') return;

  const overlayId = 'stellar-screen-flash-overlay';
  let overlay = document.getElementById(overlayId);

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '99999';
    overlay.style.transition = 'opacity 0.15s ease-out';
    document.body.appendChild(overlay);
  }

  overlay.style.backgroundColor = color;
  overlay.style.opacity = '1';

  setTimeout(() => {
    if (overlay) {
      overlay.style.opacity = '0';
    }
  }, durationMs);
}
