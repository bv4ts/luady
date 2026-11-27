'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { MANIFEST, deviceScale, loadWorldKit, pixelContext } from '../pixel/kit';
import { prefersReducedMotion, runWhileVisible, type Loop } from '../pixel/motion';
import { asset } from '../site/base';
import { drawToy } from './draw';
import { QuestionCard, type CardState } from './QuestionCard';
import { BUILD_TILES_MS, Toy, type Actor } from './sim';
import { STILL } from './world';

const STATE_WORDS: Record<Actor['state'], string> = {
  working: 'working', idle: 'idle', asleep: 'asleep', waiting: 'waiting for you, with a question',
};

/** Where an art-pixel position of the office is on the stage, in CSS pixels. */
interface Projection { cx: number; cy: number; ratio: number }
const project = (p: Projection, x: number, y: number) => ({ x: (x - p.cx) * p.ratio, y: (y - p.cy) * p.ratio });

/**
 * The office toy at the top of the landing page: the product's own office, small enough to play with. Every session
 * is a real button (with its name, room and state), so it works with a keyboard and a screen reader as well as with a
 * mouse or a finger; the canvas only draws. Without JavaScript the still picture of the same office stays.
 */
export function OfficeToy({ demoHref }: { demoHref: string | null }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const toyRef = useRef<Toy | null>(null);
  const loopRef = useRef<Loop | null>(null);
  const places = useRef(new Map<string, HTMLElement>());
  const projection = useRef<Projection>({ cx: 0, cy: 0, ratio: 1 });
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [ready, setReady] = useState(false);
  const [, setVersion] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [card, setCard] = useState<CardState | null>(null);

  const placeAll = useCallback(() => {
    const toy = toyRef.current;
    const stage = stageRef.current;
    if (toy === null || stage === null) return;
    const p = projection.current;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    for (const [key, el] of places.current) {
      let at: { x: number; y: number } | null = null;
      if (key === 'luady') at = project(p, toy.luady.x, toy.luady.y);
      else if (key.startsWith('tag:')) {
        const room = toy.rooms.find((r) => r.id === key.slice(4));
        if (room !== undefined) at = project(p, room.rect.x + 6, room.rect.y + 3);
      } else if (key === 'lot') {
        const lot = toy.nextLot;
        if (lot !== null) at = project(p, lot.rect.x + lot.rect.w / 2, lot.rect.y + lot.rect.h / 2);
      } else {
        const a = toy.actors.get(key);
        if (a === undefined) continue;
        at = project(p, a.x, a.y);
        // A new room's sessions become buttons only once they have moved in.
        if (a.bornAt > toy.now) el.dataset.unborn = '';
        else delete el.dataset.unborn;
      }
      if (at === null) continue;
      el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
      const off = at.x < -24 || at.y < -8 || at.x > width + 24 || at.y > height + 40;
      if (off) el.dataset.off = '';
      else delete el.dataset.off;
    }
    const label = labelRef.current;
    const focused = toy.focus === null ? undefined : toy.actors.get(toy.focus);
    if (label !== null) {
      if (focused === undefined || focused.bornAt > toy.now) label.dataset.hidden = '';
      else {
        delete label.dataset.hidden;
        const at = project(p, focused.x, focused.y - 34);
        label.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
      }
    }
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (stage === null || canvas === null) return undefined;
    const ctx = pixelContext(canvas);
    if (ctx === null) return undefined;
    let alive = true;
    let observer: ResizeObserver | null = null;
    let scale = 1;
    const start = performance.now();
    loadWorldKit().then((kit) => {
      if (!alive) return;
      const toy = new Toy({ announce: setAnnouncement, changed: () => setVersion((v) => v + 1) }, prefersReducedMotion());
      toyRef.current = toy;
      const measure = (first: boolean) => {
        const dpr = window.devicePixelRatio || 1;
        scale = deviceScale(1);
        canvas.width = Math.max(1, Math.round(stage.clientWidth * dpr));
        canvas.height = Math.max(1, Math.round(stage.clientHeight * dpr));
        toy.resize(canvas.width / scale, canvas.height / scale, first);
      };
      const frame = (now: number) => {
        toy.update(now - start);
        drawToy(ctx, kit, toy, scale, canvas.width, canvas.height);
        const dpr = window.devicePixelRatio || 1;
        projection.current = { cx: Math.round(toy.camera.x * scale) / scale, cy: Math.round(toy.camera.y * scale) / scale, ratio: scale / dpr };
        placeAll();
      };
      measure(true);
      observer = new ResizeObserver(() => {
        measure(false);
        loopRef.current?.poke();
      });
      observer.observe(stage);
      loopRef.current = runWhileVisible(stage, frame, 30);
      frame(performance.now());
      stage.dataset.live = '';
      setReady(true);
    }).catch(() => {
      // The still picture stays; the toy is a bonus, not the page.
    });
    return () => {
      alive = false;
      loopRef.current?.stop();
      observer?.disconnect();
    };
  }, [placeAll]);

  const keep = useCallback((key: string) => (el: HTMLElement | null) => {
    if (el === null) places.current.delete(key);
    else places.current.set(key, el);
  }, []);

  const openCard = (toy: Toy) => {
    const a = toy.asking === null ? undefined : toy.actors.get(toy.asking);
    if (a === undefined || a.question === null) return;
    setCard({ id: a.id, label: a.label, room: toy.roomName(a.room), command: a.question.command, answered: null });
  };

  const onActor = (id: string) => {
    if (suppressClick.current) return;
    const toy = toyRef.current;
    if (toy === null) return;
    if (toy.touch(id)) openCard(toy);
    loopRef.current?.poke();
  };

  const onAnswer = (allow: boolean) => {
    const toy = toyRef.current;
    if (toy === null || card === null) return;
    toy.answer(allow);
    setCard({ ...card, answered: allow ? 'allow' : 'deny' });
    loopRef.current?.poke();
  };

  const closeCard = (answered: boolean) => {
    const toy = toyRef.current;
    const id = card?.id;
    if (!answered) toy?.dismiss();
    setCard(null);
    if (id !== undefined) places.current.get(id)?.focus();
  };

  const addRoom = () => {
    const toy = toyRef.current;
    if (toy === null) return;
    toy.addRoom();
    loopRef.current?.poke();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || card !== null) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    suppressClick.current = false;
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const toy = toyRef.current;
    if (d === null || toy === null || d.id !== event.pointerId) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;
    d.moved = true;
    suppressClick.current = true;
    d.x = event.clientX;
    d.y = event.clientY;
    const ratio = projection.current.ratio;
    toy.pan(dx / ratio, event.pointerType === 'touch' ? 0 : dy / ratio);
    loopRef.current?.poke();
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    const toy = toyRef.current;
    const stage = stageRef.current;
    if (d === null || toy === null || stage === null || d.moved || event.target !== canvasRef.current) return;
    const box = stage.getBoundingClientRect();
    const p = projection.current;
    toy.touchFloor({ x: p.cx + (event.clientX - box.left) / p.ratio, y: p.cy + (event.clientY - box.top) / p.ratio });
    loopRef.current?.poke();
  };

  const toy = toyRef.current;
  const nextLot = toy?.nextLot ?? null;
  const actors = toy?.order ?? [];
  const working = (room: string) => actors.filter((a) => a.room === room && a.state === 'working' && a.bornAt <= (toy?.now ?? 0)).length;
  const tagRooms = toy === null ? [] : toy.rooms.filter((r) => {
    const b = toy.builds.find((x) => x.room.id === r.id);
    return b === undefined || toy.now - b.startedAt >= BUILD_TILES_MS;
  });
  const focused = toy?.focus == null ? undefined : toy.actors.get(toy.focus);

  return (
    <section className="toy" aria-labelledby="toy-title" aria-describedby="toy-help">
      <h2 className="sr-only" id="toy-title">A tiny office to play with</h2>
      <p className="sr-only" id="toy-help">
        Each session below is a button: it shows its name, room and state. One of them will ask a question; open it to
        answer. Add a room, or switch the lamps off and on, with the buttons under the office.
      </p>
      <div
        className="toy__stage"
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { drag.current = null; }}
      >
        {/* The same office as a still picture: what visitors without JavaScript see, and the first paint for everyone. */}
        <img
          className="toy__still"
          src={asset(`pixel/${MANIFEST.still.file}`)}
          width={STILL.w}
          height={STILL.h}
          fetchPriority="high"
          alt="The Luady office at night: an empty lot, the Cedar room with three sessions at their desks, and Luady HQ with the manager at his desk; the Ash room below."
        />
        <canvas className="toy__canvas" ref={canvasRef} aria-hidden="true" />
        {ready && toy !== null ? (
          <div className="toy__overlay">
            {tagRooms.map((room) => (
              <span key={room.id} ref={keep(`tag:${room.id}`)} className="toy__tag" aria-hidden="true">
                <span className="toy__tag-bar" ref={(el) => { el?.style.setProperty('--room', room.palette.base); }} />
                <span className="toy__tag-name">{room.name}</span>
                {room.kind === 'hq' ? null : <span className="toy__tag-count">{working(room.id)} working</span>}
              </span>
            ))}
            {actors.map((a) => (
              <button
                key={a.id}
                type="button"
                ref={keep(a.id)}
                className="toy__who"
                data-state={a.state}
                aria-label={`${a.label}, ${toy.roomName(a.room)}: ${STATE_WORDS[a.state]}`}
                onClick={() => onActor(a.id)}
                onFocus={() => toy.setFocus(a.id, true)}
                onBlur={() => toy.setFocus(null)}
                onPointerEnter={() => toy.setFocus(a.id, false)}
                onPointerLeave={() => toy.setFocus(null)}
              />
            ))}
            <button
              type="button"
              ref={keep('luady')}
              className="toy__who toy__who--luady"
              aria-label="Luady, the manager: tick the clipboard"
              onClick={() => { if (!suppressClick.current) toy.touchLuady(); }}
            />
            {nextLot === null ? null : (
              <button type="button" ref={keep('lot')} className="toy__lot" tabIndex={-1} aria-hidden="true" onClick={addRoom}>
                + Add room
              </button>
            )}
            <div className="toy__label" ref={labelRef} aria-hidden="true" data-hidden="">
              {focused === undefined ? null : (
                <>
                  <strong>{focused.label}</strong>
                  <span>{toy.roomName(focused.room)}, {STATE_WORDS[focused.state].replace(', with a question', '')}</span>
                </>
              )}
            </div>
          </div>
        ) : null}
        {card === null ? null : <QuestionCard card={card} onAnswer={onAnswer} onClose={closeCard} />}
      </div>
      <div className="toy__bar">
        <p className="toy__caption">A tiny office to play with. The real one is one click away.</p>
        <div className="toy__controls" hidden={!ready}>
          <button type="button" className="chip" onClick={addRoom} disabled={nextLot === null}>
            Add a room
          </button>
          <button
            type="button"
            className="chip chip--lamp"
            aria-pressed={toy?.lights.on ?? false}
            onClick={() => { toy?.toggleLights(); loopRef.current?.poke(); }}
          >
            Lamps
          </button>
        </div>
        {demoHref === null ? (
          <a className="btn btn--primary" href={asset('docs/getting-started/#try-the-demo')}>Run the demo on your computer</a>
        ) : (
          <a className="btn btn--primary" href={demoHref}>Open the full live demo</a>
        )}
      </div>
      {ready && nextLot === null ? <p className="toy__more">The real office takes as many rooms as you like.</p> : null}
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </section>
  );
}
