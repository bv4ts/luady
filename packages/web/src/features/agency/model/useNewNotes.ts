import { useEffect, useState } from 'react';
import { useApi } from '../../../api/context.js';
import { isApiError } from '../../../api/errors.js';
import { reportError } from '../../../lib/report.js';
import { useStore } from '../../../state/store.js';

/** Where this device remembers when the owner last opened Notes. */
export const NOTES_SEEN_KEY = 'hub.notes.seenAt';
const CHECK_LIMIT = 20;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The time Notes was last opened here; the first visit starts now, so older notes never count as new. */
export function readSeenAt(store: Store | null, now: number): number {
  try {
    const saved = Number(store?.getItem(NOTES_SEEN_KEY) ?? Number.NaN);
    if (Number.isFinite(saved)) return saved;
    store?.setItem(NOTES_SEEN_KEY, String(now));
  } catch {
    // Storage refused (private window): fall back to this page's lifetime.
  }
  return now;
}

function writeSeenAt(store: Store | null, at: number): void {
  try {
    store?.setItem(NOTES_SEEN_KEY, String(at));
  } catch {
    // Not kept across reloads; the dot still clears for this page.
  }
}

/** How many meeting notes arrived after `seenAt`. */
export function newMeetings(items: readonly { kind: string; at: string }[], seenAt: number): number {
  return items.filter((note) => note.kind === 'meeting' && Date.parse(note.at) > seenAt).length;
}

/**
 * Meeting notes the owner has not opened yet: the Notes button's dot, the notes desk's badge and
 * "Notes · 2 new". The hub counts them per note, the same on every device, and the count stays while Notes is open
 * until each note is opened. An older hub without that count: meetings that arrived since Notes was last opened on
 * this device, and opening Notes counts as seeing them. Checks again on every `notes.changed`.
 */
export function useNewNotes(open: boolean): number {
  const api = useApi();
  const version = useStore().state.notesVersion;
  const [seenAt, setSeenAt] = useState(() => readSeenAt(storage(), Date.now()));
  const [fresh, setFresh] = useState(0);
  const [hubCount, setHubCount] = useState<number | null>(null);
  const legacy = hubCount === null;

  useEffect(() => {
    if (!open) return;
    const now = Date.now();
    writeSeenAt(storage(), now);
    setSeenAt(now);
    setFresh(0);
  }, [open]);

  useEffect(() => {
    if (open && legacy) return undefined;
    let alive = true;
    api.notes({ limit: CHECK_LIMIT }).then(
      (list) => {
        if (!alive) return;
        setHubCount(list.newCount ?? null);
        setFresh(newMeetings(list.items, seenAt));
      },
      (err: unknown) => {
        // An older hub (404) or a stub (501) has no notes yet: no dot, no noise.
        if (!(isApiError(err) && (err.status === 404 || err.status === 501))) reportError('notes check', err);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, version, seenAt, open, legacy]);

  if (hubCount !== null) return hubCount;
  return open ? 0 : fresh;
}
