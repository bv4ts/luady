/**
 * The agents' speech bubbles as plain data: which are open and until when, and which have folded into a
 * small speech mark on their character. The layer that draws them feeds arrivals and the clock in; nothing here
 * touches the DOM or a timer.
 */

/** At most this many bubbles are open at once; the oldest folds first. */
export const BUBBLES_OPEN_MAX = 4;
export const BUBBLE_MIN_MS = 6_000;
export const BUBBLE_MAX_MS = 20_000;
/** Reading time per character between the two limits: 280 characters reach the 20 seconds. */
export const BUBBLE_MS_PER_CHAR = 50;

export interface OpenBubble {
  readonly sessionId: string;
  /** The arrival number of the words shown (0 for words that came with a page load). */
  readonly seq: number;
  /** Epoch ms when it folds. */
  readonly until: number;
}

export interface BubbleQueue {
  /** Oldest first. */
  readonly open: readonly OpenBubble[];
  /** Sessions whose last words wait behind a speech mark. */
  readonly folded: readonly string[];
  /** The highest arrival number taken in; anything at or below it is not new. */
  readonly seen: number;
}

/** What a session said, as the queue needs it. */
export interface SaidArrival {
  readonly sessionId: string;
  readonly seq: number;
  readonly text: string;
}

export const EMPTY_BUBBLES: BubbleQueue = Object.freeze({ open: Object.freeze([]), folded: Object.freeze([]), seen: 0 });

/** How long a bubble stays open: 6 seconds for a short line, up to 20 for a long one. */
export function bubbleMs(text: string): number {
  return Math.min(BUBBLE_MAX_MS, Math.max(BUBBLE_MIN_MS, text.trim().length * BUBBLE_MS_PER_CHAR));
}

const freeze = (open: readonly OpenBubble[], folded: readonly string[], seen: number): BubbleQueue =>
  Object.freeze({ open: Object.freeze([...open]), folded: Object.freeze([...folded]), seen });

const withoutId = (ids: readonly string[], id: string): readonly string[] => ids.filter((other) => other !== id);

/** Keeps the newest BUBBLES_OPEN_MAX open; the ones pushed out fold into their marks. */
function trim(open: readonly OpenBubble[], folded: readonly string[]): { open: readonly OpenBubble[]; folded: readonly string[] } {
  const extra = Math.max(0, open.length - BUBBLES_OPEN_MAX);
  if (extra === 0) return { open, folded };
  const pushed = open.slice(0, extra).map((bubble) => bubble.sessionId);
  return { open: open.slice(extra), folded: [...folded.filter((id) => !pushed.includes(id)), ...pushed] };
}

/** Opens (or re-opens at the end of the line) one session's bubble. */
function openOne(queue: BubbleQueue, sessionId: string, seq: number, text: string, now: number): BubbleQueue {
  const open = [...queue.open.filter((bubble) => bubble.sessionId !== sessionId), { sessionId, seq, until: now + bubbleMs(text) }];
  const trimmed = trim(open, withoutId(queue.folded, sessionId));
  return freeze(trimmed.open, trimmed.folded, Math.max(queue.seen, seq));
}

/**
 * New words open a bubble, in arrival order; words that came with a page load (arrival number 0) only leave a
 * speech mark. Words already taken in change nothing.
 */
export function arrive(queue: BubbleQueue, entries: readonly SaidArrival[], now: number): BubbleQueue {
  const fresh = entries.filter((entry) => entry.seq > queue.seen).toSorted((a, b) => a.seq - b.seq);
  const loaded = entries.filter((entry) => entry.seq === 0 && !queue.folded.includes(entry.sessionId)
    && !queue.open.some((bubble) => bubble.sessionId === entry.sessionId));
  const marked = loaded.length === 0 ? queue : freeze(queue.open, [...queue.folded, ...loaded.map((entry) => entry.sessionId)], queue.seen);
  return fresh.reduce((acc, entry) => openOne(acc, entry.sessionId, entry.seq, entry.text, now), marked);
}

/** Bubbles whose time is up fold into their marks. */
export function tick(queue: BubbleQueue, now: number): BubbleQueue {
  const due = queue.open.filter((bubble) => bubble.until <= now);
  if (due.length === 0) return queue;
  const ids = due.map((bubble) => bubble.sessionId);
  return freeze(queue.open.filter((bubble) => bubble.until > now), [...queue.folded.filter((id) => !ids.includes(id)), ...ids], queue.seen);
}

/** Pointing at or tapping a mark shows the words again for their full time. */
export function reopen(queue: BubbleQueue, arrival: SaidArrival, now: number): BubbleQueue {
  if (!queue.folded.includes(arrival.sessionId)) return queue;
  return openOne(queue, arrival.sessionId, arrival.seq, arrival.text, now);
}

/** The owner closed a bubble: it folds at once. */
export function fold(queue: BubbleQueue, sessionId: string): BubbleQueue {
  if (!queue.open.some((bubble) => bubble.sessionId === sessionId)) return queue;
  return freeze(queue.open.filter((bubble) => bubble.sessionId !== sessionId), [...withoutId(queue.folded, sessionId), sessionId], queue.seen);
}

/** Sessions that left the map (or have nothing said any more) lose their bubble and mark. */
export function keepOnly(queue: BubbleQueue, live: ReadonlySet<string>): BubbleQueue {
  const open = queue.open.filter((bubble) => live.has(bubble.sessionId));
  const folded = queue.folded.filter((id) => live.has(id));
  return open.length === queue.open.length && folded.length === queue.folded.length ? queue : freeze(open, folded, queue.seen);
}

/** When the next bubble folds; null while none is open. */
export function nextFold(queue: BubbleQueue): number | null {
  return queue.open.reduce<number | null>((soonest, bubble) => (soonest === null || bubble.until < soonest ? bubble.until : soonest), null);
}

/** Keeps an open bubble open at least until `until` (the owner points at it, or opened it to read it all). */
export function hold(queue: BubbleQueue, sessionId: string, until: number): BubbleQueue {
  const bubble = queue.open.find((other) => other.sessionId === sessionId);
  if (bubble === undefined || bubble.until >= until) return queue;
  return freeze(queue.open.map((other) => (other === bubble ? { ...other, until } : other)), queue.folded, queue.seen);
}
