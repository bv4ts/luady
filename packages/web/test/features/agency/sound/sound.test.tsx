import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SOUND_GAP_MS, TONES, createSoundEngine, type AudioContextLike, type GainLike, type OscillatorLike, type SoundEngine,
} from '../../../../src/features/agency/sound/engine.js';
import { soundFor, type SoundView } from '../../../../src/features/agency/sound/sound-events.js';
import { useLuadyThread } from '../../../../src/features/luady/useLuadyThread.js';
import { useOfficeSounds } from '../../../../src/features/agency/sound/useOfficeSounds.js';
import { chat, question } from '../../../fixtures.js';
import { fakeApi } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { agent, fleetOverview } from '../agency-fixtures.js';

/** A fake AudioContext that records every oscillator it makes. */
function fakeAudio(state = 'suspended') {
  const param = () => ({ setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  const oscillators: OscillatorLike[] = [];
  const ctx: AudioContextLike & { resume: ReturnType<typeof vi.fn> } = {
    currentTime: 0,
    destination: {},
    state,
    resume: vi.fn(async () => undefined),
    createOscillator: () => {
      const osc: OscillatorLike = { type: '', frequency: param(), connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      oscillators.push(osc);
      return osc;
    },
    createGain: (): GainLike => ({ gain: param(), connect: vi.fn() }),
  };
  return { ctx, oscillators };
}

const OPEN = { muted: false, volume: 0.6, hidden: false };

describe('the sound engine', () => {
  it('is silent until the first tap or key unlocks it, then plays and wakes the context', () => {
    const { ctx, oscillators } = fakeAudio();
    const make = vi.fn(() => ctx);
    const engine = createSoundEngine(make, () => 1_000);
    expect(engine.play('pop', OPEN)).toBe(false);
    expect(make).not.toHaveBeenCalled();
    engine.unlock();
    expect(ctx.resume).toHaveBeenCalled();
    expect(engine.play('pop', OPEN)).toBe(true);
    expect(oscillators).toHaveLength(TONES.pop.length);
  });

  it('never plays while muted, at zero volume or with the tab hidden', () => {
    const { ctx } = fakeAudio('running');
    const engine = createSoundEngine(() => ctx);
    engine.unlock();
    expect(engine.play('ding', { ...OPEN, muted: true })).toBe(false);
    expect(engine.play('ding', { ...OPEN, volume: 0 })).toBe(false);
    expect(engine.play('ding', { ...OPEN, hidden: true })).toBe(false);
  });

  it('plays at most one sound in 400 ms', () => {
    const { ctx } = fakeAudio('running');
    let now = 10_000;
    const engine = createSoundEngine(() => ctx, () => now);
    engine.unlock();
    expect(engine.play('blip', OPEN)).toBe(true);
    now += SOUND_GAP_MS - 1;
    expect(engine.play('pop', OPEN)).toBe(false);
    now += 1;
    expect(engine.play('pop', OPEN)).toBe(true);
  });

  it('stays quiet where the browser has no Web Audio', () => {
    const engine = createSoundEngine(() => null);
    engine.unlock();
    expect(engine.play('step', OPEN)).toBe(false);
  });

  it('every sound is short', () => {
    Object.values(TONES).flat().forEach((tone) => expect(tone.at + tone.length).toBeLessThanOrEqual(0.6));
  });
});

const view = (over: Partial<SoundView> = {}): SoundView => ({
  loadKey: 1, luady: new Set(['m1']), done: new Set(['1']), asks: new Set(), sessions: new Set(['birch:a']), ...over,
});

describe('which sound goes with what changed', () => {
  it('a ding for a card done, a blip for what needs you, a pop for Luady, a step for an arrival', () => {
    expect(soundFor(view(), view({ done: new Set(['1', '2']) }))).toBe('ding');
    expect(soundFor(view(), view({ asks: new Set(['Q1']) }))).toBe('blip');
    expect(soundFor(view(), view({ luady: new Set(['m1', 'm2']) }))).toBe('pop');
    expect(soundFor(view(), view({ sessions: new Set(['birch:a', 'birch:b']) }))).toBe('step');
  });

  it('the loudest news wins when several things change at once', () => {
    expect(soundFor(view(), view({ done: new Set(['1', '2']), luady: new Set(['m1', 'm2']), sessions: new Set(['x']) }))).toBe('ding');
  });

  it('nothing on the first view, after a reload, for a part still loading, or when something only went away', () => {
    expect(soundFor(null, view())).toBeNull();
    expect(soundFor(view(), view({ loadKey: 2, done: new Set(['1', '2']) }))).toBeNull();
    expect(soundFor(view({ luady: null }), view({ luady: new Set(['m1', 'm9']) }))).toBeNull();
    expect(soundFor(view(), view({ sessions: new Set() }))).toBeNull();
  });
});

function fakeEngine(): SoundEngine & { play: ReturnType<typeof vi.fn> } {
  return { unlock: vi.fn(), unlocked: () => true, play: vi.fn(() => true) };
}

function Sounds({ engine }: { engine: SoundEngine }) {
  // The chat dock loads the thread on the real page.
  useLuadyThread();
  useOfficeSounds(engine);
  return <p>office</p>;
}

describe('the office sounds', () => {
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  it('plays a pop for a new message from Luady and a blip for a new question, with the prefs volume', async () => {
    const engine = fakeEngine();
    const api = fakeApi({ luadyMessages: async () => ({ items: [], nextCursor: null }) });
    const { ws } = await renderPage(<Sounds engine={engine} />, { api, overview: fleetOverview() });
    await screen.findByText('office');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => ws.emit({ type: 'manager.message', message: chat({ id: 'm9', ts: new Date().toISOString() }) }));
    expect(engine.play).toHaveBeenLastCalledWith('pop', { muted: false, volume: 0.6, hidden: false });
    act(() => ws.emit({ type: 'question.updated', question: question({ qid: 'QNEW0001', state: 'pending' }) }));
    expect(engine.play).toHaveBeenLastCalledWith('blip', expect.objectContaining({ hidden: false }));
  });

  it('a session arriving steps in; nothing is heard for what happens while the tab is hidden', async () => {
    const engine = fakeEngine();
    const api = fakeApi({ luadyMessages: async () => ({ items: [], nextCursor: null }) });
    const { ws } = await renderPage(<Sounds engine={engine} />, { api, overview: fleetOverview() });
    act(() => ws.emit({ type: 'session.updated', session: agent('birch', 'newcomer') }));
    expect(engine.play).toHaveBeenLastCalledWith('step', expect.objectContaining({ hidden: false }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => ws.emit({ type: 'session.updated', session: agent('birch', 'another') }));
    expect(engine.play).toHaveBeenLastCalledWith('step', expect.objectContaining({ hidden: true }));
  });
});
