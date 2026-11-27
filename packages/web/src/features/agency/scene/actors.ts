import {
  BUBBLE_SIZE, HELPERS_DRAWN_MAX, HQ_ID, HQ_PALETTE, MUTE_PALETTE, SPARKLE_FRAMES, SPARKLE_SIZE, hashId, lighten,
  type AgencySnapshot, type BubbleIcon, type LuadyView, type Palette, type Species,
} from '@luady/office';
import { activityPulse, helperStep, sparkleFrame } from './activity.js';
import { Container, Sprite, Texture } from 'pixi.js';
import { createActorStore, type StageActor } from './actor-store.js';
import { bodyHeight, type CritterBox } from './critter-box.js';
import { contains, type LiveView } from './live-set.js';
import { plateBase, type Bases } from './plate-base.js';
import { poseFrame } from './poses.js';
import { hexToTint } from './rack-lights.js';
import type { TextureBank } from './textures.js';

export { createActorStore } from './actor-store.js';

/**
 * Where a character stands and how big it is, in world pixels: for picking and name plates. `x, y` are the feet,
 * `w × h` the painted body above them, `top` the head's first row and `base` where a plate may start below it
 * (the front edge of its desk while seated, else just under the feet). None of them bob.
 */
export interface ActorBody {
  readonly id: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number;
  readonly top: number; readonly base: number;
}

export interface ActorLayer {
  /** True when someone entered or left. `settle`: newcomers sit down at once (a fresh load, not an arrival). */
  apply(snapshot: AgencySnapshot, settle?: boolean): boolean;
  /** What the camera shows: only the characters of its rooms, and walkers in its chunk area, get sprites. */
  setView(view: LiveView): void;
  /** Advances walks and redraws everyone shown. True when anyone walked or left. */
  frame(nowMs: number, dtMs: number): boolean;
  setSelected(id: string | null): void;
  setHover(id: string | null): void;
  /** The character something is dragged over: framed brightly until cleared with null. */
  setDropHint(id: string | null): void;
  setReducedMotion(on: boolean): void;
  /** The characters shown now. */
  bodies(): readonly ActorBody[];
  destroy(): void;
}

/**
 * One character's sprites. The body, its picture, its bubble and the two halves of its ring always exist; the walking
 * shadow, a guest's scarf, the helpers, the marks, the sweat drop and the sparkle only while they show, so a seated
 * character costs five display objects.
 */
interface Puppet {
  readonly body: Container;
  readonly critter: Sprite;
  readonly bubble: Sprite;
  /** The soft ring round the character while it works: its back half in the body behind the picture, its front half in the overlay. */
  readonly ring: Sprite;
  readonly ringFront: Sprite;
  shadow: Sprite | null;
  scarf: { readonly node: Container; readonly box: CritterBox } | null;
  /** Little helpers (sub-agents) beside the desk; children of the body, so they sort and move with it. */
  helpers: Sprite[];
  marks: { readonly node: Container; readonly w: number; readonly h: number } | null;
  sweat: Sprite | null;
  sparkle: Sprite | null;
}

interface Look { readonly species: Species; readonly palette: Palette; readonly variant: number; readonly guest: boolean }

const SELECTED = 0xffffff;
const HOVERED = 0x9aa7bd;
/** A drop target outranks the selection and the hover. */
const DROP_TARGET = 0xffd84d;
const LUADY_LOOK: Look = Object.freeze({ species: 'manager', palette: HQ_PALETTE, variant: 0, guest: false });
/** The bubble's tail stands this far right of the feet. */
const BUBBLE_X = 3;
/**
 * Where helpers stand, from the sitter's feet. The desk is 48 px wide from 16 px left of the sitter, and desks stand
 * 64 px apart: the first two helpers stand in the gaps left and right of it, a third one behind the first.
 */
const HELPER_SPOTS: ReadonlyArray<readonly [number, number]> = Object.freeze([[-24, 1], [40, 1], [-24, -8]] as const);
/**
 * Where the ring lies, from the feet: on the desk top round a seated character (the front half over the desk, the back
 * half behind the body); round the feet of a walker.
 */
const RING_Y = { seated: -4, walking: 0 } as const;

/**
 * The ring's tints: its back half lies on the dark floor, so it is the room colour lightened; its front half lies on
 * the light desk top, so it is the room colour itself.
 */
const ringTint = (palette: Palette, half: 'back' | 'front'): number =>
  hexToTint(half === 'back' ? lighten(palette.base, 0.4) : palette.base);

const rect = (x: number, y: number, w: number, h: number, tint: number, alpha = 1): Sprite => {
  const s = new Sprite(Texture.WHITE);
  Object.assign(s, { x, y, width: w, height: h, tint, alpha });
  return s;
};

/** Four corner marks around a w × h box whose top-left is the container origin. */
const brackets = (w: number, h: number): Container => {
  const marks = new Container();
  marks.label = 'marks';
  const corners = [[0, 0, true, true], [w, 0, false, true], [0, h, true, false], [w, h, false, false]] as const;
  corners.forEach(([cx, cy, right, down]) => {
    marks.addChild(rect(right ? cx : cx - 3, cy, 4, 1, SELECTED), rect(cx, down ? cy : cy - 3, 1, 4, SELECTED));
  });
  return marks;
};

/** Knitted stripes of a guest's scarf, and the seam under it. */
const SCARF = [0xf6f1e6, 0x5aa2ff] as const;
const SCARF_SEAM = 0x10141d;

/** A guest's scarf: a striped band below the eyes with a loose end over one shoulder, sized to the picture. */
const scarfFor = (box: CritterBox): Container => {
  const scarf = new Container();
  scarf.label = 'scarf';
  const neck = -Math.round(box.h * 0.3);
  const left = -box.w / 2 + 3;
  const width = box.w - 6;
  for (let x = 0; x < width; x += 3) scarf.addChild(rect(left + x, neck, Math.min(3, width - x), 2, SCARF[(x / 3) % 2] ?? SCARF[0]));
  const end = box.w / 2 - 8;
  scarf.addChild(rect(left, neck + 2, width, 1, SCARF_SEAM, 0.5), rect(end, neck + 2, 3, 2, SCARF[1]), rect(end, neck + 4, 3, 1, SCARF[0]));
  return scarf;
};

/** One helper: a mini critter standing on the floor, anchored at its feet like the others. */
const helperSprite = ([x, y]: readonly [number, number]): Sprite => {
  const s = new Sprite(Texture.EMPTY);
  s.label = 'helper';
  s.anchor.set(0.5, 1);
  Object.assign(s, { x, y });
  return s;
};

const lookOf = (a: StageActor): Look => {
  if (a.view === null) return LUADY_LOOK;
  const { species, palette, variant, guest } = a.view.look;
  return { species, palette: a.view.visual.bubble === 'pause' ? MUTE_PALETTE : palette, variant, guest };
};

/** Everyone who is in the office now: an arrival still waiting for its turn at the door is not drawn yet. */
const onStage = (cast: readonly StageActor[]): readonly StageActor[] => cast.filter((a) => a.wait <= 0);

/** Luady shows no pixel bubble while busy (the page draws his typing bubble in HTML); asleep when he is down. */
const luadyBubble = (luady: LuadyView | null): BubbleIcon | null => (luady?.state === 'down' ? 'zzz' : null);

/** True while the character works: a session typing, or Luady busy. */
const isWorking = (a: StageActor, luady: LuadyView | null): boolean => (a.view === null ? luady?.state === 'busy' : a.view.visual.pose === 'type');

/** The room a character belongs to: its session's room, or HQ for Luady. */
const roomOfActor = (a: StageActor): string => a.view?.room ?? HQ_ID;

/** Whether the view draws a character: seated in one of its rooms, or walking inside its chunk area; none in far mode. */
const shownIn = (view: LiveView | null, a: StageActor): boolean => {
  if (view === null) return true;
  if (view.far) return false;
  return a.walk === null ? view.rooms.has(roomOfActor(a)) : contains(view.area, a.pos.x, a.pos.y);
};

const destroyMaybe = (node: Container | null): void => node?.destroy({ children: true });

export function createActorLayer(bank: TextureBank, sorted: Container, overlay: Container): ActorLayer {
  const store = createActorStore();
  const puppets = new Map<string, Puppet>();
  const seeds = new Map<string, number>();
  let luady: LuadyView | null = null;
  let bases: Bases = { luadyDesk: null };
  let selected: string | null = null;
  let hover: string | null = null;
  let dropTarget: string | null = null;
  let reduced = false;
  let view: LiveView | null = null;
  /**
   * When each session Luady started was first drawn after it came in (ms on the draw clock; null until then): its
   * sparkle plays for a short while, once, even if it leaves the view and comes back.
   */
  const sparkles = new Map<string, number | null>();
  let clock = 0;

  const seedOf = (id: string): number => {
    const known = seeds.get(id);
    if (known !== undefined) return known;
    const seed = hashId(id) % 997;
    seeds.set(id, seed);
    return seed;
  };

  const boxOf = (look: Look): CritterBox => bank.critterBox(look.species, look.palette);

  const make = (a: StageActor): Puppet => {
    const look = lookOf(a);
    const body = new Container();
    body.label = `actor:${a.id}`;
    const ring = new Sprite(bank.ring('back'));
    const ringFront = new Sprite(bank.ring('front'));
    [ring, ringFront].forEach((s, i) => {
      Object.assign(s, { label: i === 0 ? 'ring' : 'ring-front', visible: false, tint: ringTint(look.palette, i === 0 ? 'back' : 'front') });
      s.anchor.set(0.5, 0.5);
    });
    const critter = new Sprite(bank.critter(look.species, look.palette, 'idle', look.variant));
    critter.label = 'critter';
    critter.anchor.set(0.5, 1);
    body.addChild(ring, critter);
    const bubble = new Sprite(Texture.EMPTY);
    bubble.label = 'bubble';
    sorted.addChild(body);
    overlay.addChildAt(ringFront, 0);
    overlay.addChild(bubble);
    const puppet: Puppet = { body, critter, bubble, ring, ringFront, shadow: null, scarf: null, helpers: [], marks: null, sweat: null, sparkle: null };
    puppets.set(a.id, puppet);
    return puppet;
  };

  const drop = (id: string, p: Puppet): void => {
    p.body.destroy({ children: true });
    p.bubble.destroy();
    destroyMaybe(p.marks?.node ?? null);
    destroyMaybe(p.sweat);
    destroyMaybe(p.sparkle);
    p.ringFront.destroy();
    puppets.delete(id);
  };

  /** Forgets everything about the characters that left the office (not those only off screen). */
  const forgetGone = (present: ReadonlySet<string>): void => {
    seeds.forEach((_, id) => { if (!present.has(id)) seeds.delete(id); });
    sparkles.forEach((_, id) => { if (!present.has(id)) sparkles.delete(id); });
  };

  /** The walking shadow, under the picture, only while it walks. */
  const shadowOf = (p: Puppet, walking: boolean): void => {
    if (walking && p.shadow === null) {
      p.shadow = rect(-6, -1, 12, 2, 0x04060c, 0.42);
      p.body.addChildAt(p.shadow, 1);
    } else if (!walking && p.shadow !== null) {
      p.shadow.destroy();
      p.shadow = null;
    }
  };

  /** A guest's scarf, made for the picture's size and dropped once the character is no guest. */
  const scarfOf = (p: Puppet, look: Look, box: CritterBox, bob: number): void => {
    if (p.scarf !== null && (!look.guest || p.scarf.box !== box)) {
      p.scarf.node.destroy({ children: true });
      p.scarf = null;
    }
    if (!look.guest) return;
    if (p.scarf === null) {
      p.scarf = { node: scarfFor(box), box };
      p.body.addChildAt(p.scarf.node, p.body.getChildIndex(p.critter) + 1);
    }
    p.scarf.node.y = bob;
  };

  /** The bubble's tail rests on the top of the head (box.tail, above the eyes); the marks frame the painted body. */
  const decorate = (p: Puppet, a: StageActor, x: number, frameTop: number, lift: number, box: CritterBox): void => {
    const icon = a.view === null ? luadyBubble(luady) : a.view.visual.bubble;
    p.bubble.visible = icon !== null;
    if (icon !== null) Object.assign(p.bubble, { texture: bank.bubble(icon), x: x + BUBBLE_X, y: frameTop + box.tail - BUBBLE_SIZE.h + 1 + lift });
    const head = frameTop + box.head;
    const mark = a.id === dropTarget ? DROP_TARGET : a.id === selected ? SELECTED : a.id === hover ? HOVERED : null;
    const w = box.w + 3;
    const h = bodyHeight(box) + 2;
    if (mark === null || (p.marks !== null && (p.marks.w !== w || p.marks.h !== h))) {
      destroyMaybe(p.marks?.node ?? null);
      p.marks = null;
    }
    if (mark === null) return;
    if (p.marks === null) {
      p.marks = { node: brackets(w, h), w, h };
      overlay.addChild(p.marks.node);
    }
    Object.assign(p.marks.node, { x: x - box.w / 2 - 2, y: head - 2 });
    p.marks.node.children.forEach((c) => { (c as Sprite).tint = mark; });
  };

  /** Helpers busy beside the desk (stepping and bobbing) and the sweat drop by the head, only while the agent sits. */
  const extras = (p: Puppet, a: StageActor, x: number, head: number, box: CritterBox, now: number): void => {
    const seated = a.walk === null && a.view !== null;
    const count = seated ? Math.min(a.view?.helpers ?? 0, HELPERS_DRAWN_MAX) : 0;
    const palette = a.view?.look.palette ?? HQ_PALETTE;
    p.helpers.slice(count).forEach((h) => h.destroy());
    p.helpers = p.helpers.slice(0, count);
    while (p.helpers.length < count) {
      const helper = helperSprite(HELPER_SPOTS[p.helpers.length] ?? [0, 0]);
      // The one standing behind is drawn first, so the front ones are drawn over it.
      if (p.helpers.length === 2) p.body.addChildAt(helper, p.body.getChildIndex(p.critter) + 1);
      else p.body.addChild(helper);
      p.helpers.push(helper);
    }
    p.helpers.forEach((helper, i) => {
      const spot = HELPER_SPOTS[i] ?? [0, 0];
      const step = helperStep(now, i, seedOf(a.id), reduced);
      helper.texture = bank.critter('mini', palette, step.frame, 0);
      helper.x = spot[0] + step.dx;
      helper.y = spot[1] + step.bob;
    });
    const strained = seated && a.view?.strained === true;
    if (!strained) {
      destroyMaybe(p.sweat);
      p.sweat = null;
      return;
    }
    if (p.sweat === null) {
      p.sweat = new Sprite(bank.drop());
      p.sweat.label = 'sweat';
      overlay.addChild(p.sweat);
    }
    Object.assign(p.sweat, { x: x + Math.round(box.w / 2) - 2, y: head + 1 });
  };

  /** The pulsing ring round a working character: both halves breathe together. */
  const pulse = (p: Puppet, a: StageActor, look: Look, x: number, y: number, now: number): void => {
    const on = isWorking(a, luady);
    p.ring.visible = on;
    p.ringFront.visible = on;
    if (!on) return;
    const glow = activityPulse(now, seedOf(a.id), reduced);
    const lift = a.walk === null ? RING_Y.seated : RING_Y.walking;
    Object.assign(p.ring, { alpha: glow.alpha, y: lift, tint: ringTint(look.palette, 'back') });
    Object.assign(p.ringFront, { alpha: glow.alpha, x, y: y + lift, tint: ringTint(look.palette, 'front') });
    p.ring.scale.set(glow.scale);
    p.ringFront.scale.set(glow.scale);
  };

  /** The arrival sparkle round a session Luady started, over its head, for its few frames. */
  const sparkleOf = (p: Puppet, a: StageActor, x: number, head: number): void => {
    let start = sparkles.get(a.id);
    if (start === null) {
      start = clock;
      sparkles.set(a.id, clock);
    }
    const frame = start === undefined || reduced ? null : sparkleFrame(clock - start);
    if (frame === null) {
      sparkles.delete(a.id);
      destroyMaybe(p.sparkle);
      p.sparkle = null;
      return;
    }
    if (p.sparkle === null) {
      p.sparkle = new Sprite(bank.sparkle(0));
      p.sparkle.label = 'sparkle';
      p.sparkle.anchor.set(0.5, 0.5);
      overlay.addChild(p.sparkle);
    }
    p.sparkle.texture = bank.sparkle(frame % SPARKLE_FRAMES);
    Object.assign(p.sparkle, { x, y: head - Math.round(SPARKLE_SIZE.h / 2) + 4 });
  };

  const draw = (p: Puppet, a: StageActor, now: number): void => {
    const look = lookOf(a);
    const box = boxOf(look);
    const walking = a.walk !== null;
    const f = poseFrame({ species: look.species, pose: a.view?.visual.pose ?? 'sit', walking, reduced, now, seed: seedOf(a.id) });
    const x = Math.round(a.pos.x);
    const y = Math.round(a.pos.y);
    Object.assign(p.body, { x, y, zIndex: a.pos.y });
    p.critter.texture = bank.critter(look.species, look.palette, f.frame, look.variant);
    p.critter.y = 1 + f.bob;
    shadowOf(p, walking);
    scarfOf(p, look, box, f.bob);
    decorate(p, a, x, y - box.h + 1 + f.bob, f.lift, box);
    extras(p, a, x, y - box.h + 1 + box.head, box, now);
    pulse(p, a, look, x, y, now);
    sparkleOf(p, a, x, y - box.h + 1 + box.head);
  };

  return {
    apply: (snapshot, settle = false) => {
      luady = snapshot.luady;
      bases = { luadyDesk: snapshot.props.find((d) => d.kind === 'luadydesk') ?? null };
      const changes = store.apply(snapshot, { settle });
      // A session Luady started that walks in now (not one already there at load) arrives with a sparkle.
      changes.forEach((c) => {
        if (c.kind === 'enter' && c.actor.origin === 'manager' && !reduced && (store.get(c.actor.id)?.walk ?? null) !== null) sparkles.set(c.actor.id, null);
      });
      return changes.some((c) => c.kind === 'enter' || c.kind === 'leave' || c.kind === 'move');
    },
    setView: (next) => { view = next; },
    frame: (nowMs, dtMs) => {
      clock = nowMs;
      const moved = store.step(dtMs);
      const cast = onStage(store.list());
      const present = new Set(store.list().map((a) => a.id));
      const shown = cast.filter((a) => shownIn(view, a));
      const drawn = new Set(shown.map((a) => a.id));
      puppets.forEach((p, id) => { if (!drawn.has(id)) drop(id, p); });
      forgetGone(present);
      shown.forEach((a) => draw(puppets.get(a.id) ?? make(a), a, reduced ? 0 : nowMs));
      return moved;
    },
    setSelected: (id) => { selected = id; },
    setHover: (id) => { hover = id; },
    setDropHint: (id) => { dropTarget = id; },
    setReducedMotion: (on) => {
      reduced = on;
      store.setReducedMotion(on);
    },
    bodies: () =>
      onStage(store.list()).filter((a) => shownIn(view, a)).map((a) => {
        const box = boxOf(lookOf(a));
        const h = bodyHeight(box);
        return { id: a.id, x: a.pos.x, y: a.pos.y, w: box.w, h, top: a.pos.y - h + 1, base: plateBase(a, bases) };
      }),
    destroy: () => {
      puppets.forEach((p, id) => drop(id, p));
    },
  };
}
