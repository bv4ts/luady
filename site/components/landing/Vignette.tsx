'use client';

import { useEffect, useRef, useState } from 'react';
import { MANIFEST, bubble, critter, desk, deviceScale, loadKit, loadWorldKit, pixelContext, ring, roomInside, sprite, type Frame, type Kit } from '../pixel/kit';
import { prefersReducedMotion, runWhileVisible } from '../pixel/motion';

export type VignetteKind = 'servers' | 'rooms' | 'ask' | 'manager';

/** The part of the art each little scene shows, in art pixels. */
const VIEW = { w: 160, h: 88 };
const TOOLS = ['dots', 'term', 'pencil', 'search'];

interface Scene {
  /**
   * Draws the scene at time `t` (milliseconds since it started); `still` draws one frame that tells the story. The
   * scene is VIEW wide; `pad` more art pixels show on each side when the card is wider.
   */
  draw(ctx: CanvasRenderingContext2D, kit: Kit, t: number, still: boolean, pad: number): void;
  /** The visitor hovered or tapped it. */
  poke(t: number): void;
  /** The room name the scene is in (for the small name tag), if it changes. */
  room?(): { name: string; colour: string };
}

const lerpFrame = (t: number, period: number, still: boolean): Frame => (!still && t % period < 140 ? 'blink' : 'idle');
const bob = (t: number, phase: number, still: boolean) => (!still && Math.sin(t / 95 + phase) > 0.55 ? -1 : 0);

/** A room's inside under the view; `name` is a rooms.png frame, (ox, oy) where the view starts inside the room. */
function floor(ctx: CanvasRenderingContext2D, kit: Kit, name: string, ox: number, oy: number, inset = 0): void {
  roomInside(ctx, kit, name, -ox - inset, -oy - inset);
}

// ---------------------------------------------------------------- a new server's room builds itself
function serversScene(): Scene {
  let start = 0;
  const elm = MANIFEST.office.builds.find((b) => b.id === 'elm');
  const colour = elm?.palette.base ?? '#6f9a3a';
  const species = elm?.species ?? 'shield';
  const O = { x: 130, y: 22 };
  const desks = [{ x: 224, y: 62 }, { x: 160, y: 62 }];
  return {
    poke(t) {
      if (t - start > 3200) start = t - 400;
    },
    draw(ctx, kit, now, still) {
      const t = still ? 5000 : (now - start) % 7600;
      floor(ctx, kit, 'lot', O.x, O.y, 2);
      const built = Math.min(1, Math.max(0, (t - 500) / 1400));
      for (let y = 0; y < 128; y += 16) {
        for (let x = -64; x < VIEW.w + 64; x += 16) {
          if (O.x + x < 0 || O.x + x >= 416) continue;
          if (built >= 1 || (x + 64 + y) / 368 <= built) roomInside(ctx, kit, 'elm', -O.x, -O.y, { x: O.x + x, y: O.y + y, w: 16, h: 16 });
        }
      }
      desks.forEach((d, i) => {
        const at = 1950 + i * 260;
        if (t < at) return;
        const sitter = t >= 2600 + i * 320;
        if (sitter) {
          const x = d.x + 16 - O.x;
          const y = d.y + 4 - O.y;
          ring(ctx, kit, 'back', colour, x, y);
          critter(ctx, kit, colour, species, lerpFrame(t + i * 900, 2600, still), x, y + bob(t, i, still) + (!still && t - (2600 + i * 320) < 100 ? -3 : 0));
        }
        desk(ctx, kit, { x: d.x - O.x, y: d.y - O.y + (!still && t - at < 90 ? -2 : 0) }, sitter ? 'work' : 'off', colour);
        if (sitter) {
          ring(ctx, kit, 'front', colour, d.x + 16 - O.x, d.y + 4 - O.y);
          bubble(ctx, kit, TOOLS[(Math.floor(t / 1300) + i) % TOOLS.length], species, d.x + 16 - O.x, d.y + 4 - O.y);
        }
      });
    },
  };
}

// ---------------------------------------------------------------- one creature, five rooms: colours and creatures
const ROOM_LOOKS = [
  { name: 'Cedar', frame: 'cedar', inset: 2, colour: '#d6336c', species: 'bun', x: 130 },
  { name: 'Elm', frame: 'elm', inset: 0, colour: '#6f9a3a', species: 'shield', x: 130 },
  { name: 'Aspen', frame: 'aspen', inset: 0, colour: '#a78bfa', species: 'cat', x: 130 },
  { name: 'Olive', frame: 'olive', inset: 0, colour: '#b07a4a', species: 'ghost', x: 120 },
  { name: 'Hemlock', frame: 'hemlock', inset: 0, colour: '#c04fd6', species: 'cat', x: 120 },
];

function roomsScene(): Scene {
  let index = 0;
  let changedAt = 0;
  let last = 0;
  const STEP = 2200;
  return {
    poke(t) {
      index = (index + 1) % ROOM_LOOKS.length;
      changedAt = t;
    },
    room: () => ({ name: ROOM_LOOKS[index].name, colour: ROOM_LOOKS[index].colour }),
    draw(ctx, kit, t, still, pad) {
      if (!still && t - changedAt > STEP && t - last > STEP) {
        index = (index + 1) % ROOM_LOOKS.length;
        changedAt = t;
      }
      last = Math.max(last, changedAt);
      const look = ROOM_LOOKS[index];
      const prev = ROOM_LOOKS[(index + ROOM_LOOKS.length - 1) % ROOM_LOOKS.length];
      const wipe = still ? 1 : Math.min(1, (t - changedAt) / 320);
      const paint = (l: typeof look, clipW: number) => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(-pad, 0, clipW, VIEW.h);
        ctx.clip();
        floor(ctx, kit, l.frame, l.x, 22, l.inset);
        const deskX = l.x === 130 ? 224 : 128;
        const d = { x: deskX - l.x, y: 62 - 22 };
        critter(ctx, kit, l.colour, l.species, lerpFrame(t, 2400, still), d.x + 16, d.y + 4 + bob(t, 0, still));
        desk(ctx, kit, d, 'work', l.colour);
        ring(ctx, kit, 'front', l.colour, d.x + 16, d.y + 4);
        bubble(ctx, kit, 'pencil', l.species, d.x + 16, d.y + 4);
        const d2 = { x: d.x + (l.x === 130 ? -64 : 64), y: d.y };
        desk(ctx, kit, d2, 'off', l.colour);
        ctx.restore();
      };
      const full = VIEW.w + 2 * pad;
      paint(prev, full);
      paint(look, Math.round((full * wipe) / 16) * 16);
    },
  };
}

// ---------------------------------------------------------------- a question, answered
function askScene(): Scene {
  let start = 0;
  let answeredAt = -1;
  const O = { x: 130, y: 22 };
  const colour = '#d6336c';
  return {
    poke(t) {
      const local = t - start;
      if (local > 1600 && answeredAt < 0) answeredAt = t;
    },
    draw(ctx, kit, now, still) {
      if (!still && answeredAt >= 0 && now - answeredAt > 3200) {
        start = now;
        answeredAt = -1;
      }
      const t = now - start;
      if (!still && answeredAt < 0 && t > 4600) answeredAt = now;
      const since = answeredAt < 0 ? -1 : now - answeredAt;
      const waiting = still ? answeredAt < 0 : t > 1600 && answeredAt < 0;
      floor(ctx, kit, 'cedar', O.x, O.y, 2);
      const d = { x: 224 - O.x, y: 62 - O.y };
      const feet = { x: d.x + 16, y: d.y + 4 };
      const hop = waiting && !still && Math.floor(t / 320) % 2 === 0 ? -1 : 0;
      if (!waiting) ring(ctx, kit, 'back', colour, feet.x, feet.y);
      critter(ctx, kit, colour, 'bun', lerpFrame(t, 2800, still), feet.x, feet.y + hop + (waiting ? 0 : bob(t, 1, still)));
      desk(ctx, kit, d, waiting ? 'alert' : 'work', colour);
      if (!waiting) ring(ctx, kit, 'front', colour, feet.x, feet.y);
      const icon = waiting ? 'bang' : since >= 0 && since < 1400 ? 'check' : since >= 0 ? 'term' : 'dots';
      bubble(ctx, kit, icon, 'bun', feet.x, feet.y, hop);
      const d2 = { x: 160 - O.x, y: 62 - O.y };
      critter(ctx, kit, colour, 'bun', 'blink', d2.x + 16, d2.y + 4);
      desk(ctx, kit, d2, 'off', colour);
      bubble(ctx, kit, 'zzz', 'bun', d2.x + 16, d2.y + 4);
      if (!still && since >= 0 && since < 900) {
        for (let i = 0; i < 14; i += 1) {
          const a = (i / 14) * Math.PI - Math.PI;
          const r = (since / 900) * 26;
          ctx.fillStyle = ['#ffd84d', '#3cc3b0', colour, '#fff4dc'][i % 4];
          ctx.fillRect(Math.round(feet.x + Math.cos(a) * r), Math.round(feet.y - 16 + Math.sin(a) * r + (since / 900) ** 2 * 18), 2, 2);
        }
      }
    },
  };
}

// ---------------------------------------------------------------- the manager ticks his clipboard
function managerScene(): Scene {
  let tickAt = 1200;
  const O = { x: MANIFEST.office.luadySit.x - 80, y: MANIFEST.office.luadySit.y - 56 };
  const props = MANIFEST.office.props.filter((p) => p.room === 'hq');
  return {
    poke(t) {
      if (t - tickAt > 1400) tickAt = t;
    },
    draw(ctx, kit, t, still, pad) {
      if (!still && t - tickAt > 4200) tickAt = t;
      const world = MANIFEST.world;
      if (kit.world !== null) ctx.drawImage(kit.world, O.x - pad - world.x, O.y - world.y, VIEW.w + 2 * pad, VIEW.h, -pad, 0, VIEW.w + 2 * pad, VIEW.h);
      const items: { z: number; draw: () => void }[] = props.map((p) => ({ z: p.sortY, draw: () => sprite(ctx, kit, `furniture/${p.kind}`, p.x - O.x, p.y - O.y) }));
      const l = MANIFEST.office.luadySit;
      items.push({ z: l.y, draw: () => critter(ctx, kit, '#3cc3b0', 'manager', lerpFrame(t + 700, 3100, still), l.x - O.x, l.y - O.y) });
      items.sort((a, b) => a.z - b.z).forEach((item) => item.draw());
      const since = still ? 600 : t - tickAt;
      if (since >= 0 && since < 1500) bubble(ctx, kit, since < 450 ? 'list' : 'check', 'manager', l.x - O.x, l.y - O.y);
    },
  };
}

const SCENES: Record<VignetteKind, () => Scene> = { servers: serversScene, rooms: roomsScene, ask: askScene, manager: managerScene };

/**
 * A small looping scene of the product's own sprites on a feature card. It runs only while on screen and the tab is
 * visible; hovering or tapping it nudges it along; with reduced motion it is one still frame that tells the story.
 */
export function Vignette({ kind }: { kind: VignetteKind }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const startRef = useRef(0);
  const [room, setRoom] = useState<{ name: string; colour: string } | null>(null);
  const tagRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (box === null || canvas === null) return undefined;
    const ctx = pixelContext(canvas);
    if (ctx === null) return undefined;
    let alive = true;
    let stop = () => {};
    const scene = SCENES[kind]();
    sceneRef.current = scene;
    const still = prefersReducedMotion();
    const start = performance.now();
    startRef.current = start;
    void (kind === 'manager' ? loadWorldKit() : loadKit()).then((kit) => {
      if (!alive) return;
      const css = box.clientWidth >= 420 ? 3 : 2;
      const k = deviceScale(css);
      const dpr = window.devicePixelRatio || 1;
      // As wide as the card, in whole art pixels; the scene stays in the middle and the room shows more of itself.
      const width = Math.max(VIEW.w, Math.floor((box.clientWidth * dpr) / k));
      const pad = Math.floor((width - VIEW.w) / 2);
      canvas.width = width * k;
      canvas.height = VIEW.h * k;
      canvas.style.width = `${(width * k) / dpr}px`;
      canvas.style.height = `${(VIEW.h * k) / dpr}px`;
      let lastRoom = '';
      const frame = (now: number) => {
        ctx.setTransform(k, 0, 0, k, pad * k, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(-pad, 0, width, VIEW.h);
        scene.draw(ctx, kit, now - start, still, pad);
        const r = scene.room?.();
        if (r !== undefined && r.name !== lastRoom) {
          lastRoom = r.name;
          setRoom(r);
        }
      };
      box.dataset.live = '';
      if (still) {
        frame(performance.now());
        const redraw = () => frame(performance.now());
        box.addEventListener('pointerup', redraw);
        stop = () => box.removeEventListener('pointerup', redraw);
      } else {
        const loop = runWhileVisible(box, frame, 24);
        stop = () => loop.stop();
      }
    });
    return () => {
      alive = false;
      stop();
    };
  }, [kind]);

  useEffect(() => {
    if (room !== null) tagRef.current?.style.setProperty('--room', room.colour);
  }, [room]);

  const poke = () => sceneRef.current?.poke(performance.now() - startRef.current);
  return (
    <div className="vignette" ref={boxRef} onPointerEnter={poke} onPointerDown={poke} aria-hidden="true">
      <canvas ref={canvasRef} className="vignette__canvas" width={VIEW.w * 2} height={VIEW.h * 2} />
      {room === null ? null : (
        <span className="vignette__tag" ref={tagRef}>{room.name}</span>
      )}
    </div>
  );
}
