import { MUTE_PALETTE, type AgencySnapshot, type Palette } from '@luady/office';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { Feed } from '../model/feed.js';
import { badgeWords, plaqueWallRun, roomBadges, roomPlaques, type MapBadge, type RoomBadge } from '../model/map-labels.js';
import { teamStyle } from '../model/team-style.js';
import { lotPosition } from '../model/ui-state.js';
import { NO_VIEW, type LabelView } from '../model/view-rooms.js';
import type { OverlayKind, OverlayPoint, StageInsets } from '../stage-types.js';
import { applyPins, createPinRegistry, pinKey, placePin, type PinBand, type PinMode, type PinRegistry } from './map-pins.js';
import type { PlateRegistry } from './plates.js';

type Register = (kind: OverlayKind, id: string, mode: PinMode, wallRun?: number) => (node: HTMLElement | null) => (() => void) | undefined;

/** The band between the top bar and the chat bar; without insets (tests) badges are not clamped. */
function bandOf(insets: StageInsets | undefined): PinBand | undefined {
  return insets === undefined ? undefined : { top: insets.top, bottom: window.innerHeight - insets.bottom };
}

function usePins(plates: PlateRegistry, points: Feed<readonly OverlayPoint[]>, insets: StageInsets | undefined): Register {
  const [pins] = useState<PinRegistry>(createPinRegistry);
  const band = useRef<PinBand | undefined>(bandOf(insets));
  useEffect(() => {
    band.current = bandOf(insets);
    applyPins(pins, plates.last, band.current);
  }, [insets, pins, plates]);
  useEffect(() => points.subscribe((frame) => applyPins(pins, frame, band.current)), [points, pins]);
  // A notice toast that comes or goes moves the lot plaques it would cover (map-pins.ts clearOfAreas) at once.
  useEffect(() => {
    const page = typeof document === 'undefined' ? null : document.querySelector('.agency');
    if (page === null || typeof MutationObserver === 'undefined') return undefined;
    const watch = new MutationObserver(() => applyPins(pins, plates.last, band.current));
    watch.observe(page, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [pins, plates]);
  return useCallback((kind: OverlayKind, id: string, mode: PinMode, wallRun?: number) => (node: HTMLElement | null) => {
    if (node === null) return undefined;
    const key = pinKey(kind, id);
    pins.nodes.set(key, { node, mode, ...(wallRun === undefined ? {} : { wallRun }) });
    placePin(node, plates.last.find((point) => point.kind === kind && point.id === id), mode, band.current, wallRun);
    return () => {
      if (pins.nodes.get(key)?.node === node) pins.nodes.delete(key);
    };
  }, [pins, plates]);
}

const Plaque = memo(function Plaque({ roomKey, name, words, needs, palette, mode, wallRun, register }: {
  roomKey: string; name: string; words: string; needs: boolean; palette: Palette; mode: PinMode; wallRun?: number;
  register: Register;
}) {
  const [ref] = useState(() => register('room', roomKey, mode, wallRun));
  return (
    <div ref={ref} className={['map-plaque', `map-plaque--${mode}`, needs ? 'map-plaque--needs' : null].filter(Boolean).join(' ')} style={teamStyle(palette)} data-testid="room-plaque" data-room={roomKey}>
      <span className="map-plaque__name">{name}</span>
      {words === '' ? null : <span className="map-plaque__words">{words}</span>}
    </div>
  );
});

/** A room seen from far: a colour dot, its name, its agents and who needs the owner (the number is also a word). */
const FarBadge = memo(function FarBadge({ badge, register }: { badge: RoomBadge; register: Register }) {
  const [ref] = useState(() => register('room', badge.key, 'far'));
  return (
    <div ref={ref} className={badge.needs > 0 ? 'map-far map-far--needs' : 'map-far'} style={teamStyle(badge.palette)} data-testid="room-badge"
      data-room={badge.key} title={badgeWords(badge)}>
      <span className="map-far__dot" aria-hidden="true" />
      <span className="map-far__name">{badge.name}</span>
      {badge.agents === null ? null : <span className="map-far__count">{badge.agents}</span>}
      {badge.needs > 0 ? <span className="map-far__need">!{badge.needs}</span> : null}
    </div>
  );
});

const Badge = memo(function Badge({ id, badge, register }: { id: string; badge: MapBadge; register: Register }) {
  const [ref] = useState(() => register('fixture', id, badge.dot === true ? 'dot' : 'badge'));
  return (
    <span ref={ref} className={`map-badge map-badge--${badge.tone}${badge.dot === true ? ' map-badge--dot' : ''}`} data-testid="fixture-badge"
      data-fixture={id}>{badge.text}</span>
  );
});

/** A server room's plaque hangs on its back wall, clear of the rack and the board; HQ's sits on its floor corner. */
function plaqueMode(snapshot: AgencySnapshot, key: string): PinMode {
  const def = snapshot.map.rooms[key];
  if (def?.kind !== 'server' && def?.kind !== 'local' && def?.kind !== 'project') return 'plaque';
  return def.side === 'east' ? 'wall-end' : 'wall';
}

/** An empty slot's "+ Add room" plaque: a real button (the labels layer above it ignores the pointer). */
const LotPlaque = memo(function LotPlaque({ lot, register, onAdd }: { lot: string; register: Register; onAdd: (position: number) => void }) {
  const [ref] = useState(() => register('room', lot, 'lot'));
  const position = lotPosition(lot);
  if (position === null) return null;
  return (
    <button ref={ref} type="button" className="map-lot" data-testid="lot-plaque" data-room={lot} style={teamStyle(MUTE_PALETTE)}
      onClick={() => onAdd(position)} aria-label={`Add a room in spot ${position + 1}`}>
      <span aria-hidden="true">+</span> Add room
    </button>
  );
});

/**
 * Room plaques (name, and "3 working · 1 needs you"), far-mode room badges and fixture badges over the map,
 * placed from the stage's overlay points of kind `room` and `fixture`; only for the rooms the view shows (`view`).
 * Labels only: taps go through to the map, and screen readers skip them (the chips and the Rooms menu say the same).
 * The "+ Add room" plaques of empty slots are buttons, in their own layer.
 */
export const MapLabels = memo(function MapLabels({ snapshot, badges, plates, points, insets, view = NO_VIEW, onAddRoom }: {
  snapshot: AgencySnapshot; badges: Readonly<Record<string, MapBadge>>; plates: PlateRegistry; points: Feed<readonly OverlayPoint[]>;
  /** The bars' room on the stage: badges stay between them. */
  insets?: StageInsets;
  /** What the view shows (model/view-rooms.ts); before the first view, every room. */
  view?: LabelView;
  /** A "+ Add room" plaque was pressed: a new room for that spot. Absent: no plaques. */
  onAddRoom?: (position: number) => void;
}) {
  const register = usePins(plates, points, insets);
  return (
    <>
      <div className="agency-pins" aria-hidden="true">
        {view.far
          ? roomBadges(snapshot, view.rooms ?? []).map((badge) => <FarBadge key={`far-${badge.key}`} badge={badge} register={register} />)
          : roomPlaques(snapshot, view.rooms).map((plaque) => (
            <Plaque key={plaque.key} roomKey={plaque.key} name={plaque.name} words={plaque.words} needs={plaque.needs}
              palette={snapshot.map.rooms[plaque.key]?.palette ?? MUTE_PALETTE} mode={plaqueMode(snapshot, plaque.key)}
              wallRun={plaqueWallRun(snapshot, plaque.key, plaqueMode(snapshot, plaque.key))} register={register} />
          ))}
        {view.far ? null : Object.entries(badges).map(([id, badge]) => <Badge key={id} id={id} badge={badge} register={register} />)}
      </div>
      {onAddRoom === undefined || view.lots.length === 0 ? null : (
        <div className="agency-lots">
          {view.lots.map((lot) => <LotPlaque key={lot} lot={lot} register={register} onAdd={onAddRoom} />)}
        </div>
      )}
    </>
  );
});
