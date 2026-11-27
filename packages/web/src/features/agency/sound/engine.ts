/**
 * The office's sounds: short tones made with the Web Audio API, no files. The engine stays silent
 * until it is unlocked by the owner's first tap or key, while the tab is hidden, while muted, and never plays two
 * sounds within 400 ms.
 */

export type SoundKind = 'pop' | 'ding' | 'blip' | 'step';

/** The few parts of an AudioContext the engine uses (so tests can hand in a fake one). */
export interface AudioParamLike {
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
}
export interface AudioNodeLike { connect(destination: unknown): unknown }
export interface OscillatorLike extends AudioNodeLike {
  type: string;
  readonly frequency: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}
export interface GainLike extends AudioNodeLike { readonly gain: AudioParamLike }
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  readonly state: string;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  resume(): Promise<void>;
}

/** What decides whether a sound may play now. */
export interface SoundGate {
  readonly muted: boolean;
  /** 0..1 */
  readonly volume: number;
  /** The tab is hidden: what happens now is not heard. */
  readonly hidden: boolean;
}

export const SOUND_GAP_MS = 400;

interface Tone {
  readonly wave: string;
  readonly from: number;
  readonly to: number;
  /** Seconds after the sound starts. */
  readonly at: number;
  readonly length: number;
  readonly peak: number;
}

/** Each sound as one or two short tones: a rising pop, a bell-like ding, a falling two-note blip, a low soft step. */
export const TONES: Readonly<Record<SoundKind, readonly Tone[]>> = Object.freeze({
  pop: [{ wave: 'sine', from: 660, to: 1180, at: 0, length: 0.09, peak: 0.22 }],
  ding: [
    { wave: 'triangle', from: 1047, to: 1047, at: 0, length: 0.55, peak: 0.2 },
    { wave: 'sine', from: 2094, to: 2094, at: 0, length: 0.3, peak: 0.06 },
  ],
  blip: [
    { wave: 'triangle', from: 740, to: 740, at: 0, length: 0.07, peak: 0.18 },
    { wave: 'triangle', from: 554, to: 554, at: 0.1, length: 0.09, peak: 0.18 },
  ],
  step: [{ wave: 'sine', from: 210, to: 150, at: 0, length: 0.07, peak: 0.16 }],
});

const SILENT = 0.0001;

function playTone(ctx: AudioContextLike, tone: Tone, volume: number): void {
  const start = ctx.currentTime + tone.at;
  const end = start + tone.length;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = tone.wave;
  osc.frequency.setValueAtTime(tone.from, start);
  if (tone.to !== tone.from) osc.frequency.exponentialRampToValueAtTime(tone.to, end);
  gain.gain.setValueAtTime(SILENT, start);
  gain.gain.linearRampToValueAtTime(Math.max(SILENT, tone.peak * volume), start + 0.008);
  gain.gain.exponentialRampToValueAtTime(SILENT, end);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(end + 0.02);
}

export interface SoundEngine {
  /** The owner tapped or pressed a key: sounds may play from now on (browsers need a gesture to start audio). */
  unlock(): void;
  readonly unlocked: () => boolean;
  /** Plays a sound when the gate allows it; true when it played. */
  play(kind: SoundKind, gate: SoundGate): boolean;
}

/** `makeContext` returns null where the browser has no Web Audio; the engine then never plays. */
export function createSoundEngine(makeContext: () => AudioContextLike | null, now: () => number = Date.now): SoundEngine {
  let ctx: AudioContextLike | null = null;
  let unlocked = false;
  let lastAt = Number.NEGATIVE_INFINITY;
  return {
    unlock: () => {
      if (unlocked) return;
      unlocked = true;
      try {
        ctx = makeContext();
        if (ctx !== null && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
      } catch {
        ctx = null;
      }
    },
    unlocked: () => unlocked,
    play: (kind, gate) => {
      if (!unlocked || ctx === null || gate.hidden || gate.muted || gate.volume <= 0) return false;
      const at = now();
      if (at - lastAt < SOUND_GAP_MS) return false;
      lastAt = at;
      try {
        const volume = Math.min(1, gate.volume);
        TONES[kind].forEach((tone) => playTone(ctx as AudioContextLike, tone, volume));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** The browser's AudioContext, or null without Web Audio. */
export function browserAudio(): AudioContextLike | null {
  const Ctor = (globalThis as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike }).AudioContext
    ?? (globalThis as { webkitAudioContext?: new () => AudioContextLike }).webkitAudioContext;
  return Ctor === undefined ? null : new Ctor();
}
