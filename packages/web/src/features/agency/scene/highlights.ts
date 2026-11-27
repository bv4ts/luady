import type { PixelRect } from '@luady/office';
import { Container, Sprite, Texture } from 'pixi.js';

/** Outlines and glows that answer the pointer: a fixture under it, or a drop target while something is dragged. */
export interface Highlights {
  /** Room glows: add it above the floor, below the furniture. */
  readonly glow: Container;
  /** Fixture outlines: add it above the furniture. */
  readonly outline: Container;
  /** A one-pixel outline round `box`, or none. */
  outlineBox(box: PixelRect | null, tint: number): void;
  /** A soft glow inside `room`'s edge, or none. */
  glowRoom(room: PixelRect | null, tint: number): void;
  destroy(): void;
}

/** The glow's bands from the room's edge inwards: [inset, width, alpha], in map pixels. */
const GLOW_BANDS: ReadonlyArray<readonly [number, number, number]> = Object.freeze([[0, 3, 0.55], [3, 3, 0.32], [6, 4, 0.16]] as const);

const strip = (): Sprite => {
  const s = new Sprite(Texture.WHITE);
  s.visible = false;
  return s;
};

/** Places four strips as a frame of width `w` inside `r` (inset by `inset`). */
const frame = (strips: readonly Sprite[], r: PixelRect, inset: number, w: number): void => {
  const [top, bottom, left, right] = strips;
  const x = r.x + inset;
  const y = r.y + inset;
  const fw = r.w - inset * 2;
  const fh = r.h - inset * 2;
  if (top) Object.assign(top, { x, y, width: fw, height: w });
  if (bottom) Object.assign(bottom, { x, y: y + fh - w, width: fw, height: w });
  if (left) Object.assign(left, { x, y: y + w, width: w, height: fh - w * 2 });
  if (right) Object.assign(right, { x: x + fw - w, y: y + w, width: w, height: fh - w * 2 });
};

const show = (strips: readonly Sprite[], on: boolean, tint: number, alpha = 1): void =>
  strips.forEach((s) => Object.assign(s, { visible: on, tint, alpha }));

/** The sprites are made once and moved; nothing is created while the pointer moves. */
export function createHighlights(): Highlights {
  const glow = new Container();
  glow.label = 'drop-glow';
  const outline = new Container();
  outline.label = 'fixture-outline';
  const edge = [strip(), strip(), strip(), strip()];
  const bands = GLOW_BANDS.map(() => [strip(), strip(), strip(), strip()]);
  edge.forEach((s) => outline.addChild(s));
  bands.flat().forEach((s) => glow.addChild(s));
  return {
    glow,
    outline,
    outlineBox: (box, tint) => {
      show(edge, box !== null, tint);
      if (box !== null) frame(edge, { x: box.x - 1, y: box.y - 1, w: box.w + 2, h: box.h + 2 }, 0, 1);
    },
    glowRoom: (room, tint) => {
      bands.forEach((band, i) => {
        const [inset, width, alpha] = GLOW_BANDS[i] ?? [0, 0, 0];
        show(band, room !== null, tint, alpha);
        if (room !== null) frame(band, room, inset, width);
      });
    },
    destroy: () => {
      glow.destroy({ children: true });
      outline.destroy({ children: true });
    },
  };
}
