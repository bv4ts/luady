import type { DelegateTo, DelegateWhat, RoomDTO } from '@luady/shared';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type Dispatch, type PointerEvent, type ReactNode,
} from 'react';
import { useApi } from '../../../api/context.js';
import { userMessage } from '../../../api/errors.js';
import { useStore } from '../../../state/store.js';
import { roomLookup } from '../../rooms/room-lookup.js';
import type { AgencyUiAction, ModalState } from '../model/ui-state.js';
import type { StageHandle } from '../stage-types.js';
import { DragChip } from './DragChip.js';
import { GivePicker } from './GivePicker.js';
import { giveTargets, giveToast, targetName } from './targets.js';
import { useDrag, type DragDrop } from './useDrag.js';
import './give.css';

export { giveToast } from './targets.js';

export interface GiveValue {
  /** Sends cards, tickets or notes to work with Luady choosing where (POST /api/delegate, target auto). */
  give(what: readonly DelegateWhat[], label: string): void;
  /** The same with a named target; resolves true when the hub took it (a toast says what happened either way). */
  giveTo(what: readonly DelegateWhat[], label: string, to: DelegateTo, note?: string): Promise<boolean>;
  /** Starts dragging them towards a character or a room on the map (from a handle's pointerdown). */
  startDrag(what: readonly DelegateWhat[], label: string, event: PointerEvent): void;
  /** Opens the Give to… picker: everything a drag can do, by pressing. */
  openPicker(what: readonly DelegateWhat[], label: string): void;
  /** True while something is being dragged (the pop-up is shrunk out of the way). */
  readonly dragging: boolean;
}

/** What a pop-up can open on the office page; absent outside it (tests). */
export interface OfficeNav {
  openAgent(sessionId: string): void;
  openModal(modal: ModalState): void;
  /** Closes the pop-up and opens the rack panel of a host's home room (the fleet wall's server rows). */
  openRack(server: string): void;
}

const GiveContext = createContext<GiveValue | null>(null);
const NavContext = createContext<OfficeNav | null>(null);

interface Load {
  readonly what: readonly DelegateWhat[];
  readonly label: string;
}

function useOfficeNavValue(dispatch: Dispatch<AgencyUiAction> | undefined, rooms: readonly RoomDTO[]): OfficeNav | null {
  return useMemo(() => (dispatch === undefined ? null : {
    openAgent: (sessionId: string) => {
      dispatch({ type: 'modal.close' });
      dispatch({ type: 'select', id: sessionId });
    },
    openModal: (modal: ModalState) => dispatch({ type: 'modal', modal }),
    openRack: (server: string) => {
      // The rack hangs in the host's home room; a host without one has no rack on the map.
      const room = roomLookup(rooms).room(server);
      dispatch({ type: 'modal.close' });
      if (room === undefined) return;
      dispatch({ type: 'stage', event: { type: 'fixture', fixture: 'rack', id: `rack-${room.id}`, room: room.id } });
    },
  }), [dispatch, rooms]);
}

/**
 * Shares Give, Give to… and dragging with every pop-up and card. `stage` is the map's handle once it runs
 * (the drag asks it what is under the pointer); `dispatch` lets pop-ups open the agent view or another pop-up.
 */
export function GiveProvider({ stage, dispatch, children }: { stage: StageHandle | null; dispatch?: Dispatch<AgencyUiAction>; children: ReactNode }) {
  const api = useApi();
  const { state, toast } = useStore();
  const stageRef = useRef<StageHandle | null>(stage);
  const sessionsRef = useRef(state.sessions);
  const roomsRef = useRef(state.rooms);
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);
  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);
  useEffect(() => {
    roomsRef.current = state.rooms;
  }, [state.rooms]);

  const [picker, setPicker] = useState<Load | null>(null);
  const [busy, setBusy] = useState(false);

  const giveTo = useCallback(async (what: readonly DelegateWhat[], label: string, to: DelegateTo, note?: string): Promise<boolean> => {
    try {
      const result = await api.delegate({ what: [...what], to, ...(note === undefined || note === '' ? {} : { note }) });
      toast('success', giveToast(label, result.manager, targetName(to, sessionsRef.current, roomLookup(roomsRef.current))));
      return true;
    } catch (err) {
      toast('error', userMessage(err));
      return false;
    }
  }, [api, toast]);

  const give = useCallback((what: readonly DelegateWhat[], label: string) => {
    void giveTo(what, label, { kind: 'auto' });
  }, [giveTo]);

  const onDrop = useCallback((drop: DragDrop) => {
    void giveTo(drop.load.what, drop.load.label, drop.to);
  }, [giveTo]);
  const drag = useDrag({ stage: stageRef, sessions: sessionsRef, rooms: roomsRef, onDrop });
  const { startDrag: start } = drag;

  const startDrag = useCallback((what: readonly DelegateWhat[], label: string, event: PointerEvent) => {
    if (what.length > 0) start({ what, label }, event);
  }, [start]);

  const openPicker = useCallback((what: readonly DelegateWhat[], label: string) => {
    if (what.length > 0) setPicker({ what, label });
  }, []);

  const choose = useCallback(async (to: DelegateTo, note: string) => {
    if (picker === null) return;
    setBusy(true);
    const ok = await giveTo(picker.what, picker.label, to, note);
    setBusy(false);
    if (ok) setPicker(null);
  }, [giveTo, picker]);

  const dragging = drag.state.phase === 'dragging';
  const value = useMemo<GiveValue>(() => ({ give, giveTo, startDrag, openPicker, dragging }), [give, giveTo, startDrag, openPicker, dragging]);
  const nav = useOfficeNavValue(dispatch, state.rooms);
  const targets = useMemo(() => giveTargets(state.rooms, state.servers, state.sessions), [state.rooms, state.servers, state.sessions]);

  return (
    <NavContext value={nav}>
      <GiveContext value={value}>
        {children}
        {drag.state.phase === 'dragging' ? <DragChip state={drag.state} sessions={state.sessions} rooms={state.rooms} /> : null}
        {picker === null ? null : (
          <GivePicker label={picker.label} targets={targets} busy={busy} onChoose={(to, note) => void choose(to, note)} onClose={() => setPicker(null)} />
        )}
      </GiveContext>
    </NavContext>
  );
}

export function useGive(): GiveValue {
  const value = useContext(GiveContext);
  if (value === null) throw new Error('useGive must be used inside <GiveProvider>');
  return value;
}

/** Opening the agent view or another pop-up from inside a pop-up; null where the office page is not around. */
export function useOfficeNav(): OfficeNav | null {
  return useContext(NavContext);
}
