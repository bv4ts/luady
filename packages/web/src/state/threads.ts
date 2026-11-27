import type { ChatMessageDTO, TranscriptItemDTO } from '@luady/shared';
import { appendUnique, mergeNewestPage, prependUnique } from './merge.js';

export interface TranscriptState {
  readonly items: readonly TranscriptItemDTO[];
  readonly nextCursor: string | null;
  /** false while the first page is in flight; live items are buffered meanwhile. */
  readonly loaded: boolean;
}

export interface PendingLuadyMessage {
  readonly localId: string;
  readonly text: string;
  readonly ts: string;
  readonly status: 'sending' | 'sent';
}

export interface LuadyThread {
  readonly items: readonly ChatMessageDTO[];
  readonly nextCursor: string | null;
  readonly loaded: boolean;
  readonly pending: readonly PendingLuadyMessage[];
}

export const EMPTY_TRANSCRIPT: TranscriptState = { items: [], nextCursor: null, loaded: false };
export const EMPTY_THREAD: LuadyThread = { items: [], nextCursor: null, loaded: false, pending: [] };

const byUuid = (item: TranscriptItemDTO): string => item.uuid;
const byMessageId = (message: ChatMessageDTO): string => message.id;

export function loadTranscript(prev: TranscriptState | undefined, items: readonly TranscriptItemDTO[], nextCursor: string | null): TranscriptState {
  if (!prev || (!prev.loaded && prev.items.length === 0)) return { items: appendUnique([], items, byUuid), nextCursor, loaded: true };
  if (!prev.loaded) return { items: appendUnique(items, prev.items, byUuid), nextCursor, loaded: true };
  const merged = mergeNewestPage(prev.items, items, byUuid);
  return { items: merged.items, nextCursor: merged.anchored ? prev.nextCursor : nextCursor, loaded: true };
}

export function olderTranscript(prev: TranscriptState, items: readonly TranscriptItemDTO[], nextCursor: string | null): TranscriptState {
  return { ...prev, items: prependUnique(prev.items, items, byUuid), nextCursor };
}

export function appendTranscript(prev: TranscriptState, items: readonly TranscriptItemDTO[]): TranscriptState {
  const next = appendUnique(prev.items, items, byUuid);
  return next === prev.items ? prev : { ...prev, items: next };
}

function sortByTs(items: readonly ChatMessageDTO[]): readonly ChatMessageDTO[] {
  return items.toSorted((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** Drops optimistic owner messages once the hub echoes them (same text, role owner). */
function settlePending(pending: readonly PendingLuadyMessage[], delivered: readonly ChatMessageDTO[]): readonly PendingLuadyMessage[] {
  const texts = delivered.filter((message) => message.role === 'owner').map((message) => message.text);
  if (texts.length === 0 || pending.length === 0) return pending;
  const remaining = [...texts];
  const next = pending.filter((entry) => {
    const index = remaining.indexOf(entry.text);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
  return next.length === pending.length ? pending : next;
}

export function loadThread(prev: LuadyThread, items: readonly ChatMessageDTO[], nextCursor: string | null): LuadyThread {
  const merged = prev.loaded ? mergeNewestPage(prev.items, items, byMessageId) : { items: appendUnique([], items, byMessageId), anchored: false };
  return {
    items: sortByTs(merged.items),
    nextCursor: prev.loaded && merged.anchored ? prev.nextCursor : nextCursor,
    loaded: true,
    pending: settlePending(prev.pending, items),
  };
}

export function olderThread(prev: LuadyThread, items: readonly ChatMessageDTO[], nextCursor: string | null): LuadyThread {
  return { ...prev, items: sortByTs(prependUnique(prev.items, items, byMessageId)), nextCursor };
}

export function receiveLuadyMessage(prev: LuadyThread, message: ChatMessageDTO): LuadyThread {
  const pending = settlePending(prev.pending, [message]);
  if (!prev.loaded) return pending === prev.pending ? prev : { ...prev, pending };
  const items = appendUnique(prev.items, [message], byMessageId);
  return { ...prev, pending, items: items === prev.items ? prev.items : sortByTs(items) };
}

export function addPending(prev: LuadyThread, localId: string, text: string, ts: string): LuadyThread {
  return { ...prev, pending: [...prev.pending, { localId, text, ts, status: 'sending' }] };
}

export function markPendingSent(prev: LuadyThread, localId: string): LuadyThread {
  return { ...prev, pending: prev.pending.map((entry) => (entry.localId === localId ? { ...entry, status: 'sent' as const } : entry)) };
}

export function dropPending(prev: LuadyThread, localId: string): LuadyThread {
  return { ...prev, pending: prev.pending.filter((entry) => entry.localId !== localId) };
}
