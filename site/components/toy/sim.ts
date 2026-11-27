/**
 * What happens in the office toy, following the product's own behaviour: sessions at desks working (a tool bubble
 * over their head), asleep or idle; now and then one asks a question and waits (the red "!"); answering it sends it
 * back to work; a new room can be added on an empty lot; and Luady, the manager, walks to whatever was touched last
 * and ticks it off. Nothing here talks to anything: it is a toy that shows the idea.
 */
import type { BuildInfo, Point, RoomInfo } from '../pixel/kit';
import { BUILDS, HOME_ALIGN, OFFICE, STILL, WORLD, route, walkable } from './world';

export type SessionState = 'working' | 'idle' | 'asleep' | 'waiting';

export interface Question { command: string }

export interface Actor {
  id: string;
  room: string;
  label: string;
  species: string;
  colour: string;
  x: number;
  y: number;
  desk: Point;
  state: SessionState;
  bubble: string | null;
  bubbleAt: number;
  nextBubbleAt: number;
  nextBlinkAt: number;
  blinkUntil: number;
  /** When it appeared (new rooms' sessions pop in); 0 for the ones there from the start. */
  bornAt: number;
  /** A short answer mark over its head (a tick or a cross) until `until`. */
  mark: { icon: string; until: number } | null;
  question: Question | null;
  phase: number;
}

export interface Build {
  info: BuildInfo;
  room: RoomInfo;
  startedAt: number;
}

export interface Particle { x: number; y: number; vx: number; vy: number; colour: string; until: number }

export interface Luady { x: number; y: number; path: Point[]; tickAt: number; walkT: number }

const TOOL_BUBBLES = ['dots', 'pencil', 'term', 'book', 'search', 'dots', 'globe'];
const QUESTIONS: Question[] = [{ command: 'npm test' }, { command: 'npm run build' }, { command: 'git status' }];

/** Building a room: the floor tile by tile, then the frame, the desks row by row, then three sessions move in. */
export const BUILD_TILES_MS = 1500;
export const BUILD_DESKS_MS = 700;
export const BUILD_SESSION_MS = 320;
export const BUILD_DONE_MS = BUILD_TILES_MS + BUILD_DESKS_MS + 3 * BUILD_SESSION_MS;
export const LAMP_STEP_MS = 70;
const WALK_SPEED = 0.15; // map pixels per millisecond
const TICK_MS = 1300;

export interface Events {
  announce(text: string): void;
  changed(): void;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

export class Toy {
  now = 0;
  reduced: boolean;
  actors = new Map<string, Actor>();
  rooms: RoomInfo[];
  builds: Build[] = [];
  luady: Luady;
  particles: Particle[] = [];
  lights = { on: false, at: 0 };
  camera = { x: 0, y: 0, tx: 0, ty: 0, heldUntil: 0 };
  view = { w: STILL.w, h: STILL.h };
  focus: string | null = null;
  /** The session whose question card is open. */
  asking: string | null = null;
  private nextQuestionAt: number;
  private lastAsked: string | null = null;
  private introAt: number;
  private events: Events;

  constructor(events: Events, reduced: boolean) {
    this.events = events;
    this.reduced = reduced;
    this.rooms = Object.values(OFFICE.rooms).filter((r) => !r.lot || r.id === 'hq');
    for (const a of OFFICE.actors) {
      const desk = OFFICE.desks.find((d) => d.room === a.room && d.sit.x === a.x && d.sit.y === a.y)?.desk ?? { x: a.x - 16, y: a.y - 4 };
      this.actors.set(a.id, this.makeActor(a.id, a.room, a.label, a.species, a.colour, { x: a.x, y: a.y }, desk, a.state as SessionState, a.bubble, 0));
    }
    this.luady = { x: OFFICE.luadySit.x, y: OFFICE.luadySit.y, path: [], tickAt: -1, walkT: 0 };
    this.lights = { on: reduced, at: -10_000 };
    this.nextQuestionAt = reduced ? 3000 : 5200;
    this.introAt = reduced ? -1 : 1900;
  }

  private makeActor(id: string, room: string, label: string, species: string, colour: string, at: Point, desk: Point,
    state: SessionState, bubble: string | null, bornAt: number): Actor {
    return {
      id, room, label, species, colour, x: at.x, y: at.y, desk, state, bubble, bubbleAt: -10_000,
      nextBubbleAt: rand(2500, 7000), nextBlinkAt: rand(800, 4000), blinkUntil: 0, bornAt, mark: null, question: null, phase: Math.random() * Math.PI * 2,
    };
  }

  /** The sessions in reading order: room by room, as the office lists them. */
  get order(): Actor[] {
    return [...this.actors.values()];
  }

  roomName(id: string): string {
    return this.rooms.find((r) => r.id === id)?.name ?? OFFICE.rooms[id]?.name ?? id;
  }

  /** The next lot to build on, or null when the toy's four lots are all rooms. */
  get nextLot(): BuildInfo | null {
    return BUILDS[this.builds.length] ?? null;
  }

  // ------------------------------------------------------------------ camera

  /** Where the camera rests: over the still's first view, with Cedar's desks kept in the middle of a narrow stage. */
  home(): { x: number; y: number } {
    const x = this.view.w >= STILL.w ? STILL.x - (this.view.w - STILL.w) / 2 : STILL.x + HOME_ALIGN * (STILL.w - this.view.w);
    const y = this.view.h >= STILL.h ? STILL.y - (this.view.h - STILL.h) / 2 : STILL.y;
    return this.clampCamera(Math.round(x), Math.round(y));
  }

  clampCamera(x: number, y: number): { x: number; y: number } {
    const maxX = WORLD.x + WORLD.w - this.view.w;
    const maxY = WORLD.y + WORLD.h - this.view.h;
    return { x: Math.min(Math.max(x, WORLD.x), Math.max(WORLD.x, maxX)), y: Math.min(Math.max(y, WORLD.y), Math.max(WORLD.y, maxY)) };
  }

  resize(w: number, h: number, first: boolean): void {
    this.view = { w, h };
    const at = first ? this.home() : this.clampCamera(this.camera.tx, this.camera.ty);
    this.camera.tx = at.x;
    this.camera.ty = at.y;
    if (first || this.reduced) {
      this.camera.x = at.x;
      this.camera.y = at.y;
    }
  }

  /** Moves the camera just enough to show `box` (with a margin), and keeps it there for a while. */
  show(box: { x: number; y: number; w: number; h: number }, holdMs = 6000): void {
    const m = 24;
    let { tx, ty } = this.camera;
    if (box.x - m < tx) tx = box.x - m;
    if (box.x + box.w + m > tx + this.view.w) tx = box.x + box.w + m - this.view.w;
    if (box.y - m < ty) ty = box.y - m;
    if (box.y + box.h + m > ty + this.view.h) ty = box.y + box.h + m - this.view.h;
    const at = this.clampCamera(Math.round(tx), Math.round(ty));
    this.camera.tx = at.x;
    this.camera.ty = at.y;
    this.camera.heldUntil = this.now + holdMs;
    if (this.reduced) {
      this.camera.x = at.x;
      this.camera.y = at.y;
    }
  }

  /** The visitor dragged the office sideways or up and down by (dx, dy) map pixels. */
  pan(dx: number, dy: number): void {
    const at = this.clampCamera(this.camera.x - dx, this.camera.y - dy);
    this.camera.x = at.x;
    this.camera.y = at.y;
    this.camera.tx = at.x;
    this.camera.ty = at.y;
    this.camera.heldUntil = this.now + 12_000;
  }

  inView(p: Point, margin = 0): boolean {
    return p.x >= this.camera.x + margin && p.x < this.camera.x + this.view.w - margin && p.y >= this.camera.y + margin && p.y < this.camera.y + this.view.h - margin;
  }

  // ------------------------------------------------------------------ what the visitor does

  /**
   * A session was hovered or focused: it looks up and shows its label. Focus from the keyboard (`reveal`) also moves
   * the camera to it when it is out of view; a passing mouse never does.
   */
  setFocus(id: string | null, reveal = false): void {
    if (this.focus === id) return;
    this.focus = id;
    const a = id === null ? null : this.actors.get(id);
    if (a && reveal) this.show({ x: a.x - 30, y: a.y - 50, w: 60, h: 60 }, 8000);
    this.events.changed();
  }

  /** A session was clicked or tapped. Returns true when that opened its question. */
  touch(id: string): boolean {
    const a = this.actors.get(id);
    if (a === undefined) return false;
    this.walkTo({ x: a.x, y: a.desk.y + 32 });
    if (a.state === 'waiting' && a.question !== null) {
      this.asking = id;
      this.events.changed();
      return true;
    }
    if (a.state === 'asleep') {
      a.state = 'working';
      this.setBubble(a, 'dots');
      this.events.announce(`${a.label} woke up and is working again.`);
      this.events.changed();
    } else {
      a.bubbleAt = this.now;
    }
    return false;
  }

  /** Luady was clicked: he ticks his clipboard where he stands. */
  touchLuady(): void {
    this.luady.tickAt = this.now;
    this.events.announce('Luady ticks his clipboard.');
  }

  /** The floor was clicked: Luady walks there, if it is a floor. */
  touchFloor(p: Point): void {
    const spot = walkable(p, this.rooms);
    if (spot !== null) this.walkTo(spot);
  }

  answer(allow: boolean): void {
    const a = this.asking === null ? undefined : this.actors.get(this.asking);
    this.asking = null;
    if (a === undefined || a.question === null) return;
    const command = a.question.command;
    a.question = null;
    a.state = 'working';
    a.mark = { icon: allow ? 'check' : 'cross', until: this.now + 1400 };
    this.setBubble(a, allow ? 'term' : 'dots');
    this.walkTo({ x: a.x, y: a.desk.y + 32 });
    if (allow && !this.reduced) this.confetti(a.x, a.y - 14, a.colour);
    this.nextQuestionAt = this.now + rand(9000, 14_000);
    this.events.announce(allow ? `Allowed. ${a.label} runs ${command} and gets back to work.` : `Denied. ${a.label} carries on without running ${command}.`);
    this.events.changed();
  }

  /** Closes the question card without answering; the session keeps waiting. */
  dismiss(): void {
    this.asking = null;
    this.events.changed();
  }

  toggleLights(): void {
    this.lights = { on: !this.lights.on, at: this.now };
    this.events.announce(this.lights.on ? 'The lamps are on.' : 'The lamps are off.');
    this.events.changed();
  }

  /** Builds a room on the next empty lot. Returns false when there is none left. */
  addRoom(): boolean {
    const info = this.nextLot;
    if (info === null) return false;
    const room: RoomInfo = {
      id: info.id, name: info.name, kind: 'server', rect: info.rect, doorway: info.doorway, palette: info.palette,
      species: info.species, side: info.side, lot: false,
    };
    const startedAt = this.reduced ? this.now - BUILD_DONE_MS : this.now;
    this.builds.push({ info, room, startedAt });
    this.rooms.push(room);
    this.show(info.rect, BUILD_DONE_MS + 4000);
    const d = info.doorway;
    this.walkTo({ x: d.x + d.w / 2, y: d.y > info.rect.y + info.rect.h / 2 ? info.rect.y + info.rect.h - 20 : info.rect.y + 44 });
    info.desks.slice(0, 3).forEach((slot, k) => {
      const id = `${info.id}-${k + 1}`;
      const actor = this.makeActor(id, info.id, id, info.species, info.palette.base, slot.sit, slot.desk, 'working', pick(TOOL_BUBBLES),
        startedAt + BUILD_TILES_MS + BUILD_DESKS_MS + k * BUILD_SESSION_MS);
      this.actors.set(id, actor);
    });
    this.events.announce(`Room ${info.name} added, with three sessions at work.`);
    this.events.changed();
    return true;
  }

  // ------------------------------------------------------------------ time

  private setBubble(a: Actor, icon: string | null): void {
    a.bubble = icon;
    a.bubbleAt = this.now;
    a.nextBubbleAt = this.now + rand(3500, 8000);
  }

  private walkTo(target: Point): void {
    if (this.reduced) {
      this.luady.x = target.x;
      this.luady.y = target.y;
      this.luady.path = [];
      this.luady.tickAt = this.now;
      return;
    }
    this.luady.path = route({ x: this.luady.x, y: this.luady.y }, target, this.rooms);
    this.luady.tickAt = -1;
  }

  private confetti(x: number, y: number, colour: string): void {
    const colours = [colour, '#ffd84d', '#3cc3b0', '#fff4dc'];
    for (let i = 0; i < 34; i += 1) {
      const angle = rand(-Math.PI * 0.95, -Math.PI * 0.05);
      const speed = rand(0.05, 0.16);
      this.particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, colour: pick(colours), until: this.now + rand(900, 1500) });
    }
  }

  private askSomeone(): void {
    const candidates = this.order.filter((a) => a.state === 'working' && a.id !== this.lastAsked && a.bornAt <= this.now && this.inView({ x: a.x, y: a.y - 12 }, 16));
    const fallback = this.order.filter((a) => a.state === 'working' && a.id !== this.lastAsked);
    const list = candidates.length > 0 ? candidates : fallback;
    if (list.length === 0) return;
    const first = this.lastAsked === null ? list.find((a) => a.id === 'cedar-1') : undefined;
    const a = first ?? pick(list);
    a.state = 'waiting';
    a.question = this.lastAsked === null ? QUESTIONS[0] : pick(QUESTIONS);
    this.lastAsked = a.id;
    this.setBubble(a, 'bang');
    this.events.announce(`${a.label} in ${this.roomName(a.room)} has a question for you.`);
    this.events.changed();
  }

  update(now: number): void {
    const prev = this.now;
    const dt = Math.min(now - prev, 100);
    this.now = now;
    if (!this.lights.on && !this.reduced && this.lights.at < 0 && now > 350) this.lights = { on: true, at: now };
    if (this.introAt >= 0 && now >= this.introAt) {
      this.introAt = -1;
      const a = this.actors.get('cedar-1');
      if (a !== undefined) this.walkTo({ x: a.x, y: a.desk.y + 32 });
    }
    if (now >= this.nextQuestionAt && this.asking === null && !this.order.some((a) => a.state === 'waiting')) {
      this.askSomeone();
      this.nextQuestionAt = Number.POSITIVE_INFINITY;
    }
    // A new room's floor finished, or one of its sessions moved in: the labels and buttons change with it.
    for (const b of this.builds) {
      for (const at of [BUILD_TILES_MS, BUILD_TILES_MS + BUILD_DESKS_MS, ...[0, 1, 2].map((k) => BUILD_TILES_MS + BUILD_DESKS_MS + k * BUILD_SESSION_MS)]) {
        const when = b.startedAt + at;
        if (when > prev && when <= now) this.events.changed();
      }
    }
    for (const a of this.actors.values()) {
      if (a.mark !== null && now > a.mark.until) a.mark = null;
      if (now >= a.nextBlinkAt) {
        a.blinkUntil = now + 140;
        a.nextBlinkAt = now + rand(2200, 6000);
      }
      if (a.state === 'working' && now >= a.nextBubbleAt) this.setBubble(a, pick(TOOL_BUBBLES.filter((b) => b !== a.bubble)));
    }
    this.moveLuady(dt);
    this.moveCamera(dt);
    this.particles = this.particles.filter((p) => p.until > now);
    for (const p of this.particles) {
      p.vy += 0.00032 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  private moveLuady(dt: number): void {
    const l = this.luady;
    if (l.path.length === 0) return;
    let budget = WALK_SPEED * dt;
    l.walkT += dt;
    while (budget > 0 && l.path.length > 0) {
      const next = l.path[0];
      const dx = next.x - l.x;
      const dy = next.y - l.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= budget) {
        l.x = next.x;
        l.y = next.y;
        budget -= dist;
        l.path.shift();
      } else {
        l.x += (dx / dist) * budget;
        l.y += (dy / dist) * budget;
        budget = 0;
      }
    }
    if (l.path.length === 0) l.tickAt = this.now;
  }

  private moveCamera(dt: number): void {
    const c = this.camera;
    if (this.now > c.heldUntil && c.heldUntil !== 0 && this.asking === null) {
      const at = this.home();
      c.tx = at.x;
      c.ty = at.y;
      c.heldUntil = 0;
    }
    if (this.reduced) {
      c.x = c.tx;
      c.y = c.ty;
      return;
    }
    const k = 1 - Math.exp(-dt / 260);
    c.x += (c.tx - c.x) * k;
    c.y += (c.ty - c.y) * k;
    if (Math.abs(c.tx - c.x) < 0.3) c.x = c.tx;
    if (Math.abs(c.ty - c.y) < 0.3) c.y = c.ty;
  }

  /** Luady's clipboard: the list he looks at, then the tick, for a moment after he arrives. */
  luadyMark(): string | null {
    if (this.luady.tickAt < 0) return null;
    const t = this.now - this.luady.tickAt;
    if (t < 0 || t > TICK_MS) return null;
    return t < 420 ? 'list' : 'check';
  }

  isWalking(): boolean {
    return this.luady.path.length > 0;
  }
}
