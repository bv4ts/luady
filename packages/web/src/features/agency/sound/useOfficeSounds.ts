import { useEffect, useRef } from 'react';
import { useStore } from '../../../state/store.js';
import { usePrefsUpdate } from '../model/usePrefsUpdate.js';
import { browserAudio, createSoundEngine, type SoundEngine, type SoundGate } from './engine.js';
import { soundFor, soundView, type SoundView } from './sound-events.js';

let shared: SoundEngine | null = null;

/** The one sound engine of the page (the settings page's test sound uses it too). */
export function officeSound(): SoundEngine {
  shared ??= createSoundEngine(browserAudio);
  return shared;
}

const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** The first tap or key on the page unlocks the sounds (browsers start audio only after a gesture). */
function useUnlock(engine: SoundEngine): void {
  useEffect(() => {
    if (engine.unlocked()) return undefined;
    const unlock = () => {
      engine.unlock();
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
    return () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    };
  }, [engine]);
}

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement);

/** M mutes and unmutes (not while typing, with a modifier, or while a modal dialog owns the keyboard). */
function useMuteKey(muted: boolean): void {
  const update = usePrefsUpdate();
  const state = useRef({ muted, update });
  useEffect(() => {
    state.current = { muted, update };
  }, [muted, update]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'm' && event.key !== 'M') return;
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      event.preventDefault();
      void state.current.update({ sound: { muted: !state.current.muted } });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

/**
 * Plays the office's sounds from what the store hears: a ding for a card done, a blip for something that needs the
 * owner, a pop for a message from Luady, a soft step for a session that arrived. Nothing while the tab is hidden (what
 * happened then stays silent), nothing before the first tap or key, at most one sound in 400 ms.
 */
export function useOfficeSounds(engine: SoundEngine = officeSound()): void {
  const { state } = useStore();
  const { muted, volume } = state.prefs.value.sound;
  const last = useRef<SoundView | null>(null);
  useUnlock(engine);
  useMuteKey(muted);

  useEffect(() => {
    const next = soundView(state, Date.now());
    const kind = soundFor(last.current, next);
    last.current = next;
    if (kind === null) return;
    const gate: SoundGate = { muted, volume, hidden: hidden() };
    engine.play(kind, gate);
  }, [state, engine, muted, volume]);
}
