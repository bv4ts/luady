import type { ChatMessageDTO } from '@luady/shared';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useStore } from '../../../state/store.js';
import { isNoUpdate } from '../../luady/no-update.js';
import { IDLE_FLOW, nextFlowChange, reduceLuadyFlow, type LuadyFlow } from './luady-flow.js';

/** A Luady message older than this when it reaches the page (a reload, an older page) is history, not an answer. */
const FRESH_MS = 60_000;

const fromLuady = (message: ChatMessageDTO): boolean => message.role === 'manager' || message.role === 'assistant';

export interface LuadyFlowValue {
  readonly flow: LuadyFlow;
  /** The owner's message went out (call before the request). */
  readonly sent: () => void;
  /** The hub kept it: Luady is signed out. */
  readonly held: () => void;
  readonly close: () => void;
}

/**
 * Drives what shows above Luady (luady-flow.ts) from the store: his status, and each new message of his that arrives
 * while the page is open. A message he writes by himself (a mission finished) opens above him too.
 */
export function useLuadyFlow(): LuadyFlowValue {
  const { state } = useStore();
  const [flow, dispatch] = useReducer(reduceLuadyFlow, IDLE_FLOW);
  // `off` passes through: luady-flow keeps it quiet (no pop, no "offline" note).
  const luadyState = state.luady?.state ?? null;
  const luadyRef = useRef(luadyState);
  const known = useRef<Set<string> | null>(null);
  const { items, loaded } = state.luadyThread;

  useEffect(() => {
    luadyRef.current = luadyState;
    if (luadyState !== null) dispatch({ type: 'status', now: Date.now(), luady: luadyState });
  }, [luadyState]);

  useEffect(() => {
    if (!loaded) return;
    const mine = items.filter(fromLuady);
    if (known.current === null) {
      known.current = new Set(mine.map((message) => message.id));
      return;
    }
    const seen = known.current;
    const fresh = mine.filter((message) => !seen.has(message.id));
    fresh.forEach((message) => seen.add(message.id));
    const now = Date.now();
    const newest = fresh.filter((message) => now - Date.parse(message.ts) < FRESH_MS && !isNoUpdate(message.text)).at(-1);
    if (newest !== undefined) dispatch({ type: 'reply', now, messageId: newest.id });
  }, [items, loaded]);

  useEffect(() => {
    const at = nextFlowChange(flow);
    if (at === null) return undefined;
    const timer = setTimeout(() => dispatch({ type: 'tick', now: Date.now() }), Math.max(0, at - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [flow]);

  const sent = useCallback(() => dispatch({ type: 'send', now: Date.now(), luady: luadyRef.current }), []);
  const held = useCallback(() => dispatch({ type: 'held', now: Date.now() }), []);
  const close = useCallback(() => dispatch({ type: 'close' }), []);
  return { flow, sent, held, close };
}
