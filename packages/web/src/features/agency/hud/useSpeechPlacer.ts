import { useCallback, useEffect, useRef, useState } from 'react';
import type { Feed } from '../model/feed.js';
import type { OverlayPoint, StageInsets } from '../stage-types.js';
import type { PlateRegistry } from './plates.js';
import {
  markClearOfPlaques, separateSpeech, sizeFor, speechSpot, type PxRect, type SpeechBounds, type SpeechBox, type SpeechSpot,
} from './speech-place.js';

/** Registers a speech node for one character; returns the ref callback to put on it. */
export type SpeechRegister = (id: string) => (node: HTMLElement | null) => (() => void) | undefined;

interface Placed {
  readonly key: string;
}

/** What was last written to each node, so a frame where nothing moved costs no style write. */
const written = new WeakMap<HTMLElement, Placed>();
/** Each node's size, kept by a ResizeObserver so placing never forces a layout read. */
const sizes = new WeakMap<HTMLElement, { w: number; h: number }>();

function boundsOf(insets: StageInsets): SpeechBounds {
  return { left: insets.left, top: insets.top, right: window.innerWidth - insets.right, bottom: window.innerHeight - insets.bottom };
}

/** Where one node goes for its point (null = hide it); keeps its size class in step with the zoom. */
function spotOf(node: HTMLElement, point: OverlayPoint | undefined, bounds: SpeechBounds): { spot: SpeechSpot | null; w: number; h: number } {
  if (point !== undefined && node.dataset.fixed !== 'size') {
    const size = sizeFor(point);
    if (node.dataset.size !== size) node.dataset.size = size;
  }
  const size = sizes.get(node) ?? { w: node.offsetWidth, h: node.offsetHeight };
  return { spot: speechSpot(point, size.w, size.h, bounds, node.dataset.lift !== 'none'), w: size.w, h: size.h };
}

/** Writes one node's place straight to the DOM (no React render per frame); hides it without a spot. */
function writeSpot(node: HTMLElement, spot: SpeechSpot | null): void {
  const key = spot === null ? 'hidden' : `${spot.left}|${spot.top}|${spot.tailX}|${spot.below ? 1 : 0}|${spot.room}`;
  if (written.get(node)?.key === key) return;
  written.set(node, { key });
  node.hidden = spot === null;
  if (spot === null) return;
  node.style.transform = `translate3d(${spot.left}px, ${spot.top}px, 0px)`;
  node.style.setProperty('--tail-x', `${spot.tailX}px`);
  node.style.setProperty('--speech-room', `${spot.room}px`);
  node.dataset.below = spot.below ? 'true' : 'false';
}

const isMark = (node: HTMLElement | undefined): boolean => node?.classList.contains('speech-mark') === true;

/**
 * The room plaques on screen, in the speech layer's own pixels (read once per frame, only while a folded mark is
 * shown, before anything is written).
 */
function plaqueRects(sample: HTMLElement): PxRect[] {
  const origin = (sample.offsetParent ?? document.body).getBoundingClientRect();
  return Array.from(document.querySelectorAll<HTMLElement>('.map-plaque')).filter((node) => !node.hidden).map((node) => {
    const r = node.getBoundingClientRect();
    return { left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top };
  }).filter((r) => r.right > r.left && r.bottom > r.top);
}

/**
 * Places every node, keeps folded marks off the room plaques, then moves neighbours apart so no bubble covers another
 * (oldest node first); a mark moved by that is kept off the plaques again.
 */
export function placeAllSpeech(nodes: ReadonlyMap<string, HTMLElement>, byId: ReadonlyMap<string, OverlayPoint>, bounds: SpeechBounds): void {
  const boxes: SpeechBox[] = [];
  nodes.forEach((node, id) => {
    const { spot, w, h } = spotOf(node, byId.get(id), bounds);
    if (spot === null) writeSpot(node, null);
    else boxes.push({ id, spot, width: w, height: h });
  });
  const marks = boxes.filter((box) => isMark(nodes.get(box.id)));
  const plaques = marks.length === 0 ? [] : plaqueRects(nodes.get(marks[0]!.id)!);
  const clear = (box: SpeechBox): SpeechBox => (plaques.length > 0 && isMark(nodes.get(box.id)) ? markClearOfPlaques(box, byId.get(box.id), plaques, bounds) : box);
  for (const box of separateSpeech(boxes.map(clear), bounds).map(clear)) {
    const node = nodes.get(box.id);
    if (node !== undefined) writeSpot(node, box.spot);
  }
}

/**
 * Keeps the speech nodes on their characters: placed from every frame the stage sends (`feed`), from the last frame
 * when a node mounts, and again when a node's size changes (new words, another zoom) or the window resizes.
 */
export function useSpeechPlacer(registry: PlateRegistry, feed: Feed<readonly OverlayPoint[]>, insets: StageInsets): SpeechRegister {
  const nodes = useRef(new Map<string, HTMLElement>());
  const insetsRef = useRef(insets);

  const placeAll = useCallback((points: readonly OverlayPoint[]) => {
    const bounds = boundsOf(insetsRef.current);
    const byId = new Map(points.filter((point) => point.kind === 'actor').map((point) => [point.id, point]));
    placeAllSpeech(nodes.current, byId, bounds);
  }, []);

  useEffect(() => {
    insetsRef.current = insets;
    placeAll(registry.last);
  }, [insets, placeAll, registry]);

  useEffect(() => feed.subscribe(placeAll), [feed, placeAll]);

  // One observer for every node: a changed size re-places that node from the last frame.
  const [resize] = useState(() => (typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        sizes.set(node, { w: node.offsetWidth, h: node.offsetHeight });
      }
      placeAll(registry.last);
    })
    : null));
  useEffect(() => () => resize?.disconnect(), [resize]);

  useEffect(() => {
    const onResize = () => placeAll(registry.last);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [placeAll, registry]);

  return useCallback((id: string) => (node: HTMLElement | null) => {
    if (node === null) return undefined;
    nodes.current.set(id, node);
    written.delete(node);
    placeAll(registry.last);
    resize?.observe(node);
    return () => {
      resize?.unobserve(node);
      if (nodes.current.get(id) === node) nodes.current.delete(id);
    };
  }, [placeAll, registry, resize]);
}
