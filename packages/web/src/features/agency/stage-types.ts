import type { AgencySnapshot, FixtureKind, PixelRect } from '@luady/office';
import type { RoomDTO } from '@luady/shared';

/** What the camera should show. */
export type StageFocus =
  | { readonly kind: 'all' }
  | { readonly kind: 'room'; readonly room: string }
  | { readonly kind: 'actor'; readonly id: string };

/** CSS pixels of the stage that the top bar, chat line and panels cover. */
export interface StageInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * What the owner did on the map. Coordinates are CSS pixels from
 * the stage's top-left corner. A fixture's `id` is `${kind}-${room}`; `hover.fixture` is the fixture id under the pointer.
 */
export type StageEvent =
  | { readonly type: 'room'; readonly room: string | null }
  | { readonly type: 'actor'; readonly id: string }
  | { readonly type: 'menu'; readonly id: string; readonly x: number; readonly y: number }
  | { readonly type: 'fixture'; readonly fixture: FixtureKind; readonly id: string; readonly room: string }
  | { readonly type: 'hover'; readonly id: string | null; readonly fixture: string | null; readonly x: number; readonly y: number };

export type OverlayKind = 'actor' | 'fixture' | 'room';

/**
 * Where something is on screen, for HTML plates, badges and plaques. All values are CSS pixels from the stage's
 * top-left corner. An actor: `x` its middle, `y` the top of its head, `footY` the bottom of its desk front while it sits
 * there (Luady: his desk) else just under its feet, `maxWidth` the widest plate that does not reach the next desk.
 * A fixture: `x, y` its anchor and `footY` equals `y`. A room: `x, y` its top-left inside corner, `maxWidth` its inside width.
 */
export interface OverlayPoint {
  readonly kind: OverlayKind;
  /** Actor id, fixture id, or room key. */
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly footY: number;
  readonly maxWidth: number;
  readonly visible: boolean;
  /** CSS pixels per map pixel now. */
  readonly scale: number;
}

export type StageTarget =
  | { readonly kind: 'actor'; readonly id: string }
  | { readonly kind: 'room'; readonly room: string }
  | { readonly kind: 'fixture'; readonly id: string };

/** What the page can ask the stage while it runs. */
export interface StageHandle {
  /** What is under a point, in CSS pixels from the stage's top-left corner. */
  pick(x: number, y: number): StageTarget | null;
  /** Light up a character or a room while something is dragged. */
  setDropHint(target: StageTarget | null): void;
}

/** Day and night: on or off (one fixed look), and the owner's quiet hours (HQ's lights low). */
export interface StageAmbience { readonly enabled: boolean; readonly quiet: boolean }

/**
 * What the camera shows: the world rectangle of the whole stage in map pixels, the zoom (CSS pixels per
 * map pixel), and far mode (zoomed out below 0.45, or more than 80 live rooms). In far mode the scene draws no
 * per-room objects: the HUD draws a badge per room instead, for at most the 300 rooms nearest the view's centre.
 */
export interface StageView { readonly rect: PixelRect; readonly scale: number; readonly far: boolean }

/**
 * What `window.__luadyStageStats()` reports in dev and demo builds. MiB of GPU texture bytes
 * (width × height × 4). `pending` counts chunks still to paint, live chunks not yet at their wanted lod, and textures
 * waiting for their release: read memory only once it is 0.
 */
export interface StageStats {
  readonly textures: number;
  /** The map, daylight and garden chunks. */
  readonly textureMiB: number;
  /** Everything else: characters, furniture, the sheet and its recoloured pages. */
  readonly otherMiB: number;
  readonly displayObjects: number;
  readonly chunksLive: number;
  readonly liveRooms: number;
  readonly pending: number;
  /** True in far mode. */
  readonly far: boolean;
  /** The largest side of any chunk texture held. */
  readonly largestSide: number;
}

declare global {
  interface Window { __luadyStageStats?: () => StageStats }
}

export interface AgencyStageProps {
  readonly snapshot: AgencySnapshot;
  /**
   * Changes with every fresh load of the whole overview (page load, reconnect). The snapshot that comes with a new
   * value seats everyone it adds at once: they were there already, they did not just arrive. Later ones walk in.
   */
  readonly settleKey: number;
  readonly focus: StageFocus;
  readonly selectedId: string | null;
  readonly insets: StageInsets;
  readonly reducedMotion: boolean;
  readonly onEvent: (event: StageEvent) => void;
  readonly onFrame: (points: readonly OverlayPoint[]) => void;
  readonly onFailed: (reason: string) => void;
  /** Called with the handle once the scene runs, and with null when it goes away. */
  readonly onReady?: (handle: StageHandle | null) => void;
  /** Absent: day and night on, not quiet. The scene reads the clock itself, once a minute. */
  readonly ambience?: StageAmbience;
  /** Called once per animation frame while the view moves, and once when it settles. */
  readonly onView?: (view: StageView) => void;
  /**
   * The office's rooms (`GET /api/rooms`), when the page has them. Absent: the snapshot's own map, which is the classic
   * four on the compat path. Present while the snapshot was built from other rooms (its map is not theirs): the stage
   * shows these rooms empty, no sessions, until a snapshot of the same rooms arrives. The snapshot is built with
   * `SnapshotInput.rooms` set to the same list, and from then on is drawn as it is.
   */
  readonly rooms?: readonly RoomDTO[];
}

/** Luady is not a session; this is his id in events and overlay points. */
export const LUADY_ACTOR_ID = 'manager';
