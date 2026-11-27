import { BUBBLE_SIZE } from '@luady/office';
import { describe, expect, it } from 'vitest';
import { EDGE_PX, MARK_GAP_PX, MIN_ROOM_PX, SPEECH_GAP_PX, TAIL_PX, markClearOfPlaques, separateSpeech, sizeFor, speechSpot } from '../../../../src/features/agency/hud/speech-place.js';
import type { OverlayPoint } from '../../../../src/features/agency/stage-types.js';

const point = (over: Partial<OverlayPoint> = {}): OverlayPoint => ({
  kind: 'actor', id: 'birch:a', x: 500, y: 400, footY: 440, maxWidth: 80, visible: true, scale: 1, ...over,
});
const BOUNDS = { left: 0, top: 56, right: 1280, bottom: 736 };
const lift = (scale: number) => (BUBBLE_SIZE.h + 1) * scale;

describe('speechSpot', () => {
  it('centres the box above the status bubble with the tail on the character', () => {
    const spot = speechSpot(point(), 180, 60, BOUNDS);
    expect(spot).toMatchObject({ left: 410, top: Math.round(400 - lift(1) - TAIL_PX - 60), tailX: 90, below: false });
  });

  it('stays inside the free band: pushed in from the edges, the tail still points at the character', () => {
    const spot = speechSpot(point({ x: 20 }), 180, 60, BOUNDS);
    expect(spot?.left).toBe(EDGE_PX);
    expect(spot?.tailX).toBe(12);
    const right = speechSpot(point({ x: 1275 }), 180, 60, BOUNDS);
    expect(right?.left).toBe(1280 - EDGE_PX - 180);
    expect(right?.tailX).toBe(180 - 12);
  });

  it('never covers the top bar: with no room above it hangs under the feet', () => {
    const spot = speechSpot(point({ y: 90, footY: 130 }), 180, 60, BOUNDS);
    expect(spot).toMatchObject({ below: true, top: 130 + TAIL_PX });
  });

  it('never covers the chat bar: a tall box gets the space above and scrolls inside', () => {
    const spot = speechSpot(point({ y: 300, footY: 700 }), 360, 900, BOUNDS);
    expect(spot?.below).toBe(false);
    expect(spot?.room).toBe(Math.floor(300 - lift(1) - TAIL_PX - (56 + EDGE_PX)));
    expect(spot?.top).toBe(56 + EDGE_PX);
  });

  it('keeps a minimum height to scroll in', () => {
    expect(speechSpot(point({ y: 120, footY: 720 }), 180, 400, BOUNDS)?.room).toBe(MIN_ROOM_PX);
  });

  it('nothing for a missing, hidden or broken point', () => {
    expect(speechSpot(undefined, 180, 60, BOUNDS)).toBeNull();
    expect(speechSpot(point({ visible: false }), 180, 60, BOUNDS)).toBeNull();
    expect(speechSpot(point({ x: Number.NaN }), 180, 60, BOUNDS)).toBeNull();
  });

  it('room size from the zoom', () => {
    expect(sizeFor(point({ scale: 1.4 }))).toBe('office');
    expect(sizeFor(point({ scale: 3.5 }))).toBe('room');
  });
});

describe('separateSpeech', () => {
  const box = (id: string, x: number, below = false) => {
    const spot = speechSpot(point({ id, x, ...(below ? { y: 90, footY: 130 } : {}) }), 180, 60, BOUNDS)!;
    return { id, spot, width: 180, height: 60 };
  };
  const overlap = (a: { spot: { left: number; top: number } }, b: { spot: { left: number; top: number } }) =>
    a.spot.left < b.spot.left + 180 && b.spot.left < a.spot.left + 180 && a.spot.top < b.spot.top + 60 && b.spot.top < a.spot.top + 60;

  it('leaves bubbles that do not touch where they are', () => {
    const boxes = [box('a', 200), box('b', 800)];
    expect(separateSpeech(boxes, BOUNDS)).toEqual(boxes);
  });

  it('moves a later neighbour up, clear of the earlier bubble, keeping its tail on its character', () => {
    const [a, b] = separateSpeech([box('a', 500), box('b', 560)], BOUNDS);
    expect(a!.spot.top).toBe(box('a', 500).spot.top);
    expect(b!.spot.top).toBe(a!.spot.top - 60 - SPEECH_GAP_PX);
    expect(b!.spot.tailX).toBe(box('b', 560).spot.tailX);
    expect(overlap(a!, b!)).toBe(false);
  });

  it('stacks three neighbours without any two covering each other', () => {
    const out = separateSpeech([box('a', 500), box('b', 540), box('c', 580)], BOUNDS);
    expect(overlap(out[0]!, out[1]!) || overlap(out[0]!, out[2]!) || overlap(out[1]!, out[2]!)).toBe(false);
  });

  it('a bubble hanging under its character moves further down', () => {
    const [a, b] = separateSpeech([box('a', 500, true), box('b', 560, true)], BOUNDS);
    expect(b!.spot.top).toBe(a!.spot.top + 60 + SPEECH_GAP_PX);
  });
});

describe('markClearOfPlaques', () => {
  const plaque = { left: 400, top: 300, right: 560, bottom: 322 };
  const markAt = (left: number, top: number) => ({ id: 'birch:a', width: 22, height: 20, spot: { left, top, tailX: 11, below: false, room: 72 } });
  const hits = (box: { spot: { left: number; top: number }; width: number; height: number }) =>
    box.spot.left < plaque.right && plaque.left < box.spot.left + box.width && box.spot.top < plaque.bottom && plaque.top < box.spot.top + box.height;

  it('leaves a mark that touches no plaque where it is', () => {
    const box = markAt(600, 300);
    expect(markClearOfPlaques(box, point({ x: 611, y: 340 }), [plaque], BOUNDS)).toBe(box);
  });

  it('moves a mark off a plaque to the side of its character\'s head, staying close to it', () => {
    const p = point({ x: 500, y: 340, footY: 380 });
    const moved = markClearOfPlaques(markAt(489, 304), p, [plaque], BOUNDS);
    expect(hits(moved)).toBe(false);
    expect(Math.abs(moved.spot.left + 11 - p.x)).toBeLessThan(40);
    expect(Math.abs(moved.spot.top - p.y)).toBeLessThan(60);
  });

  it('when both sides are covered too, it sits just below the plaque', () => {
    const wide = { left: 300, top: 300, right: 700, bottom: 345 };
    const moved = markClearOfPlaques(markAt(489, 304), point({ x: 500, y: 340, footY: 380 }), [wide], BOUNDS);
    expect(moved.spot.top).toBe(wide.bottom + MARK_GAP_PX);
  });
});
