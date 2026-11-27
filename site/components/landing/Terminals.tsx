'use client';

import { useEffect, useRef } from 'react';
import { MANIFEST, bubble, critter, desk, deviceScale, loadKit, pixelContext, ring, roomInside, sprite, type Kit } from '../pixel/kit';
import { prefersReducedMotion } from '../pixel/motion';
import { asset } from '../site/base';

/** Cedar, the room the terminals fold into: its framed picture is 420 x 276 art pixels, the inside starts at (2, 2). */
const ROOM = { w: 420, h: 276, inset: 2 };
const CEDAR = MANIFEST.office.rooms.cedar;
const COLOUR = CEDAR?.palette.base ?? '#d6336c';
const SPECIES = CEDAR?.species ?? 'bun';
/** The desks in Cedar, room-local, in the order the terminals land on them. */
const DESKS = [224, 160, 96, 32, 224, 160].map((x, i) => ({ x, y: i < 4 ? 62 : 126 }));
/** Cedar's own furniture (the rack, the plant, the links board), room-local. */
const PROPS = MANIFEST.office.props.filter((p) => p.room === 'cedar')
  .map((p) => ({ kind: p.kind, x: p.x - (CEDAR?.rect.x ?? 0) + ROOM.inset, y: p.y - (CEDAR?.rect.y ?? 0) + ROOM.inset }));
const SESSIONS = ['meadow-vat', 'meadow-share', 'meadow-hr', 'harbor-api', 'pine-docs', 'kite-web'];
const TOOLS = ['term', 'pencil', 'dots', 'search', 'book', 'dots'];
/** Where each terminal window sits in the pile, as a share of the stage (its top-left corner). */
const PILE = [[0.08, 0.06], [0.3, 0.16], [0.52, 0.05], [0.16, 0.42], [0.42, 0.5], [0.62, 0.34]];
const WINDOW = { w: 176, h: 108 };

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const ease = (t: number) => 1 - (1 - t) ** 3;
/** When terminal i starts and finishes its flight, as scroll progress. */
const flight = (i: number) => ({ from: 0.12 + i * 0.1, to: 0.3 + i * 0.1 });

function drawRoom(ctx: CanvasRenderingContext2D, kit: Kit, landed: boolean[], t: number, motion: boolean, dim: number): void {
  roomInside(ctx, kit, 'cedar', 0, 0);
  for (const p of PROPS) sprite(ctx, kit, `furniture/${p.kind}`, p.x, p.y);
  const order = DESKS.map((d, i) => ({ d, i })).sort((a, b) => a.d.y - b.d.y);
  for (const { d, i } of order) {
    const at = { x: d.x + ROOM.inset, y: d.y + ROOM.inset };
    const feet = { x: at.x + 16, y: at.y + 4 };
    if (landed[i]) {
      ring(ctx, kit, 'back', COLOUR, feet.x, feet.y);
      const lift = motion && Math.sin(t / 95 + i * 1.7) > 0.55 ? -1 : 0;
      critter(ctx, kit, COLOUR, SPECIES, motion && (t + i * 700) % 3100 < 140 ? 'blink' : 'idle', feet.x, feet.y + lift);
    }
    desk(ctx, kit, at, landed[i] ? 'work' : 'off', COLOUR);
    if (landed[i]) {
      ring(ctx, kit, 'front', COLOUR, feet.x, feet.y);
      bubble(ctx, kit, TOOLS[(i + Math.floor(t / 1700)) % TOOLS.length], SPECIES, feet.x, feet.y);
    }
  }
  for (const x of [224, 160, 96, 32]) desk(ctx, kit, { x: x + ROOM.inset, y: 190 + ROOM.inset }, 'off', COLOUR);
  if (dim > 0) {
    ctx.fillStyle = `rgba(7, 11, 24, ${(Math.round(dim * 4) / 4) * 0.62})`;
    ctx.fillRect(0, 0, ROOM.w, ROOM.h);
  }
}

/**
 * "From a pile of terminals to an office": as the visitor scrolls, six terminal windows, one per Claude Code session,
 * fly from a pile onto the desks of a room and become creatures at work. With reduced motion, or without JavaScript,
 * it is the finished room, standing still.
 */
export function Terminals({ intro }: { intro: string }) {
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const windows = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const section = sectionRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (section === null || stage === null || canvas === null) return undefined;
    const ctx = pixelContext(canvas);
    if (ctx === null) return undefined;
    const motion = !prefersReducedMotion();
    let alive = true;
    let kit: Kit | null = null;
    let scale = 1;
    let handle = 0;
    let onScreen = false;
    const start = performance.now();

    const size = () => {
      const css = stage.parentElement !== null && stage.parentElement.clientWidth >= 860 && window.innerHeight >= 780 ? 2 : 1;
      scale = deviceScale(css);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = ROOM.w * scale;
      canvas.height = ROOM.h * scale;
      stage.style.setProperty('--room-w', `${(ROOM.w * scale) / dpr}px`);
      stage.style.setProperty('--room-h', `${(ROOM.h * scale) / dpr}px`);
      stage.style.setProperty('--art', `${scale / dpr}`);
    };

    const progress = () => {
      if (!motion) return 1;
      const box = section.getBoundingClientRect();
      const room = box.height - window.innerHeight;
      return room <= 0 ? 1 : clamp(-box.top / room);
    };

    const render = (now: number) => {
      handle = 0;
      if (!alive || kit === null) return;
      const p = progress();
      const landed = DESKS.map((_, i) => p >= flight(i).to);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.imageSmoothingEnabled = false;
      drawRoom(ctx, kit, landed, now - start, motion, motion ? Math.max(0, 1 - p / 0.3) : 0);
      const dpr = window.devicePixelRatio || 1;
      const art = scale / dpr;
      const W = stage.clientWidth;
      const H = stage.clientHeight;
      windows.current.forEach((el, i) => {
        if (el === null) return;
        const { from, to } = flight(i);
        const f = ease(clamp((p - from) / (to - from)));
        if (!motion || p >= to) {
          el.dataset.gone = '';
          return;
        }
        delete el.dataset.gone;
        const d = DESKS[i];
        // The middle of the desk's monitor, in stage pixels (the room picture is centred in the stage).
        const roomLeft = (W - ROOM.w * art) / 2;
        const roomTop = (H - ROOM.h * art) / 2;
        const target = { x: roomLeft + (d.x + ROOM.inset + 38) * art, y: roomTop + (d.y + ROOM.inset - 2) * art };
        const pile = { x: PILE[i][0] * Math.max(0, W - WINDOW.w) + WINDOW.w / 2, y: PILE[i][1] * Math.max(0, H - WINDOW.h) + WINDOW.h / 2 };
        const x = pile.x + (target.x - pile.x) * f - WINDOW.w / 2;
        const y = pile.y + (target.y - pile.y) * f - WINDOW.h / 2;
        const shrink = (16 * art) / WINDOW.w;
        const s = Math.round((1 + (shrink - 1) * f) * 16) / 16;
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${Math.max(s, shrink)})`;
      });
      if (motion && onScreen) handle = requestAnimationFrame(render);
    };

    const kick = () => {
      if (handle === 0 && alive) handle = requestAnimationFrame(render);
    };
    const observer = new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      if (onScreen) kick();
    });
    observer.observe(section);
    const onResize = () => {
      size();
      kick();
    };
    window.addEventListener('resize', onResize);
    size();
    void loadKit().then((loaded) => {
      if (!alive) return;
      kit = loaded;
      if (motion) section.dataset.live = '';
      stage.dataset.ready = '';
      kick();
    });
    return () => {
      alive = false;
      if (handle !== 0) cancelAnimationFrame(handle);
      observer.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <section className="pile" id="from-terminals" aria-labelledby="pile-title" ref={sectionRef}>
      <div className="pile__sticky">
        <div className="wrap pile__in">
          <div className="pile__text">
            <h2 id="pile-title">From a pile of terminals to an office</h2>
            <p dangerouslySetInnerHTML={{ __html: intro }} />
          </div>
          <div className="pile__stage" ref={stageRef}>
            {/* The finished room from the office's still picture: without JavaScript this is the scene. */}
            <div className="pile__still">
              <img src={asset(`pixel/${MANIFEST.still.file}`)} width={MANIFEST.still.w} height={MANIFEST.still.h} loading="lazy" decoding="async"
                alt="The Cedar room of the office, with sessions working at their desks." />
            </div>
            <canvas ref={canvasRef} className="pile__room" aria-hidden="true" />
            {SESSIONS.map((name, i) => (
              <div className="term" key={name} ref={(el) => { windows.current[i] = el; }} aria-hidden="true" data-gone="">
                <div className="term__bar"><i /><i /><i /><span>cedar:~/{name}</span></div>
                <div className="term__body"><span className="term__prompt">$</span> claude<span className="term__cursor" /></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
