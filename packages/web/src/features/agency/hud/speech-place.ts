import { BUBBLE_SIZE } from '@luady/office';
import type { OverlayPoint } from '../stage-types.js';

/** At this zoom (CSS pixels per map pixel) or more the camera is on a room: bubbles get the room size. */
export const ROOM_SCALE = 2;
/** The bubble's tail, from the box to the character. */
export const TAIL_PX = 8;
/** Kept free from the bars and the screen edges. */
export const EDGE_PX = 8;
/** A bubble never gets less height to scroll in than this, even in a cramped spot. */
export const MIN_ROOM_PX = 72;

/** The free band of the stage in CSS pixels: what the bars and an open panel leave. */
export interface SpeechBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface SpeechSpot {
  readonly left: number;
  readonly top: number;
  /** Where the tail meets the box, from the box's left edge (it points at the character even when the box is pushed in). */
  readonly tailX: number;
  /** The box hangs under the character because there is no room above. */
  readonly below: boolean;
  /** The height the box may take before it scrolls inside. */
  readonly room: number;
}

export type SpeechSize = 'office' | 'room';

export const sizeFor = (point: OverlayPoint): SpeechSize => (point.scale >= ROOM_SCALE ? 'room' : 'office');

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

/** Where the map's own status bubble ends above a head: speech goes above it, so the status icon stays visible. */
export const liftOf = (point: OverlayPoint): number => (BUBBLE_SIZE.h + 1) * point.scale;

/**
 * Where a speech box of `width` × `height` goes for a character: centred above its status bubble (right above the
 * head with `lifted` false: Luady has no status bubble), inside the free
 * band; under its feet when the space above is too small and there is more below. Null when the point is missing,
 * off stage or not a number.
 */
export function speechSpot(
  point: OverlayPoint | undefined, width: number, height: number, bounds: SpeechBounds, lifted = true,
): SpeechSpot | null {
  if (point === undefined || !point.visible || ![point.x, point.y, point.footY, point.scale].every(Number.isFinite)) return null;
  const anchor = point.y - (lifted ? liftOf(point) : 0);
  const above = anchor - TAIL_PX - (bounds.top + EDGE_PX);
  const below = bounds.bottom - EDGE_PX - (point.footY + TAIL_PX);
  const goBelow = height > above && below > above;
  const room = Math.max(MIN_ROOM_PX, Math.floor(goBelow ? below : above));
  const shown = Math.min(height, room);
  const top = goBelow ? point.footY + TAIL_PX : anchor - TAIL_PX - shown;
  const left = clamp(point.x - width / 2, bounds.left + EDGE_PX, bounds.right - EDGE_PX - width);
  return {
    left: Math.round(left),
    top: Math.round(clamp(top, bounds.top + EDGE_PX, bounds.bottom - EDGE_PX - shown)),
    tailX: Math.round(clamp(point.x - left, 12, width - 12)),
    below: goBelow,
    room,
  };
}

/** Space kept between two neighbouring bubbles. */
export const SPEECH_GAP_PX = 4;

/** One placed bubble: its spot and its size in CSS pixels. */
export interface SpeechBox {
  readonly id: string;
  readonly spot: SpeechSpot;
  readonly width: number;
  readonly height: number;
}

const shownHeight = (box: SpeechBox): number => Math.min(box.height, box.spot.room);

function covers(a: SpeechBox, top: number, b: SpeechBox): boolean {
  return a.spot.left < b.spot.left + b.width && b.spot.left < a.spot.left + a.width
    && top < b.spot.top + shownHeight(b) && b.spot.top < top + shownHeight(a);
}

/**
 * Neighbouring bubbles never cover each other: in the order given (oldest first), a bubble that overlaps one already
 * placed moves further from its character (up, or down when it hangs under the feet) until it is clear, staying
 * inside the free band. Its tail keeps pointing at its own character.
 */
export function separateSpeech(boxes: readonly SpeechBox[], bounds: SpeechBounds): SpeechBox[] {
  const placed: SpeechBox[] = [];
  for (const box of boxes) {
    const height = shownHeight(box);
    let top = box.spot.top;
    for (let tries = 0; tries <= placed.length; tries += 1) {
      const hit = placed.find((other) => covers(box, top, other));
      if (hit === undefined) break;
      top = box.spot.below ? hit.spot.top + shownHeight(hit) + SPEECH_GAP_PX : hit.spot.top - height - SPEECH_GAP_PX;
    }
    top = clamp(top, bounds.top + EDGE_PX, bounds.bottom - EDGE_PX - height);
    placed.push(top === box.spot.top ? box : { ...box, spot: { ...box.spot, top: Math.round(top) } });
  }
  return placed;
}

/** A rectangle in CSS pixels of the stage (a room plaque, say). */
export interface PxRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Space kept between a folded speech mark and a plaque, or a character's head. */
export const MARK_GAP_PX = 3;
/** Half a character's head, in map pixels: a mark beside the head starts this far from its middle. */
const HEAD_HALF_MAP_PX = 7;

function overlapsAny(left: number, top: number, box: SpeechBox, rects: readonly PxRect[]): PxRect | undefined {
  return rects.find((r) => left < r.right && r.left < left + box.width && top < r.bottom && r.top < top + box.height);
}

/**
 * A folded speech mark never sits on a room plaque's text: it stays with its character, moving beside the head (right,
 * then left) and, when both sides are covered too, just below the plaque. A mark clear of every plaque stays put.
 */
export function markClearOfPlaques(box: SpeechBox, point: OverlayPoint | undefined, plaques: readonly PxRect[], bounds: SpeechBounds): SpeechBox {
  const hit = overlapsAny(box.spot.left, box.spot.top, box, plaques);
  if (hit === undefined || point === undefined) return box;
  const side = HEAD_HALF_MAP_PX * point.scale + MARK_GAP_PX;
  const headTop = point.y - box.height;
  const candidates = [
    { left: point.x + side, top: headTop },
    { left: point.x - side - box.width, top: headTop },
    { left: box.spot.left, top: hit.bottom + MARK_GAP_PX },
  ].map((c) => ({
    left: Math.round(clamp(c.left, bounds.left + EDGE_PX, bounds.right - EDGE_PX - box.width)),
    top: Math.round(clamp(c.top, bounds.top + EDGE_PX, bounds.bottom - EDGE_PX - box.height)),
  }));
  const free = candidates.find((c) => overlapsAny(c.left, c.top, box, plaques) === undefined) ?? candidates[candidates.length - 1]!;
  return { ...box, spot: { ...box.spot, left: free.left, top: free.top } };
}
