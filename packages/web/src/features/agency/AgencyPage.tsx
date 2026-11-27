import { isEmptySlot, isFurnished, type AgencySnapshot } from '@luady/office';
import type { OfficeRef } from '@luady/shared';
import { Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { StatusBanners } from '../../layout/StatusBanners.js';
import { useStore } from '../../state/store.js';
import '@fontsource/pixelify-sans/latin-500.css';
import '@fontsource/pixelify-sans/latin-600.css';
import { BrandMark } from '../../ui/BrandMark.js';
import { ActivityPill } from './hud/ActivityPill.js';
import { ActorMenu } from './hud/ActorMenu.js';
import { ChatDock } from './hud/ChatDock.js';
import { HoverTip } from './hud/HoverTip.js';
import { HudTools } from './hud/HudTools.js';
import { MapLabels } from './hud/MapLabels.js';
import { NamePlates } from './hud/NamePlates.js';
import { NotePopover } from './hud/NotePopover.js';
import { NoticeToasts } from './hud/NoticeToasts.js';
import { SpeechLayer } from './hud/SpeechLayer.js';
import { TopBar } from './hud/TopBar.js';
import { TopBarExtras } from './hud/TopBarExtras.js';
import { applyPoints, createPlateRegistry } from './hud/plates.js';
import { useAccounts } from './drawers/useAccounts.js';
import { useJiraSites } from './drawers/jira/useJiraSites.js';
import { GiveProvider } from './give/GiveContext.js';
import { createFeed } from './model/feed.js';
import { offMapNeedPath } from './model/need-route.js';
import { INITIAL_UI, reduceAgencyUi, type ActorMenuAt, type AgencyUi, type AgencyUiAction } from './model/ui-state.js';
import { useAgencySnapshot } from './model/useAgencySnapshot.js';
import { useAmbience } from './model/useAmbience.js';
import { useHudBadges } from './model/useHudBadges.js';
import { useLuadyFlow } from './model/useLuadyFlow.js';
import { useShowMe } from './model/useShowMe.js';
import { useWelcomeBack } from './model/useWelcomeBack.js';
import { WelcomeBack } from './hud/WelcomeBack.js';
import { useHelpKey } from './hud/useHelpKey.js';
import { useOfficeSounds } from './sound/useOfficeSounds.js';
import { useNoticeAcks } from './model/useNoticeAcks.js';
import { useMediaQuery, useViewport } from './model/useViewport.js';
import { OfficeBoundary } from './OfficeBoundary.js';
import { CLASSIC_PATH, officeFallbackState } from './office-notice.js';
import { OpenModal } from './OpenModal.js';
import { useLabelView } from './model/useLabelView.js';
import { roomLookup } from '../rooms/room-lookup.js';
import { OpenPanel } from './OpenPanel.js';
import { stageInsets } from './panels/insets.js';
import { LUADY_ACTOR_ID, type OverlayPoint, type StageEvent, type StageHandle } from './stage-types.js';
import { useShortcuts } from './useShortcuts.js';
import './agency.css';
import './hud/kit.css';
import './hud/live-hud.css';
import './hud/map-labels.css';

const AgencyStage = lazy(() => import('./scene/AgencyStage.js'));

/** Rendered by the boundary when the stage crashed while drawing: hand over to the classic view. */
function StageFailed({ onFailed }: { onFailed: (reason: string) => void }) {
  useEffect(() => {
    onFailed('stage-crashed');
  }, [onFailed]);
  return null;
}

/** Drops a selection, menu, note box or camera focus whose agent left the map (its session ended or was removed). */
function useGoneActors(snapshot: AgencySnapshot, ui: AgencyUi, dispatch: Dispatch<AgencyUiAction>): void {
  const focusId = ui.focus.kind === 'actor' ? ui.focus.id : null;
  const menuId = ui.menu?.id ?? null;
  const noteId = ui.note?.id ?? null;
  useEffect(() => {
    const gone = [...new Set([ui.selectedId, menuId, noteId, focusId])].filter((id): id is string =>
      id !== null && id !== LUADY_ACTOR_ID && !Object.hasOwn(snapshot.actors, id));
    if (gone.length > 0) dispatch({ type: 'gone', ids: gone });
  }, [snapshot.actors, ui.selectedId, menuId, noteId, focusId, dispatch]);
}

/** The note box of an agent that is still a session; nothing once it is gone (useGoneActors then closes it). */
function OpenNote({ at, onClose }: { at: ActorMenuAt; onClose: () => void }) {
  const { state } = useStore();
  const session = state.sessions.find((candidate) => candidate.id === at.id);
  return session === undefined ? null : <NotePopover at={at} session={session} onClose={onClose} />;
}

/** The HUD's dispatch: the bell's next step opens the classic session page when that session has no character. */
function useHudDispatch(snapshot: AgencySnapshot, ui: AgencyUi, dispatch: Dispatch<AgencyUiAction>): Dispatch<AgencyUiAction> {
  const navigate = useNavigate();
  return useCallback((action: AgencyUiAction) => {
    const offMap = action.type === 'next-need' ? offMapNeedPath(action.needs, ui.selectedId, snapshot.actors) : null;
    if (offMap === null) dispatch(action);
    else void navigate(offMap);
  }, [dispatch, navigate, snapshot.actors, ui.selectedId]);
}

/** `/?open=accounts` (the Settings link) or `/?open=notices` opens that drawer once, then leaves the address clean. */
function useOpenFromLink(dispatch: Dispatch<AgencyUiAction>): void {
  const [params, setParams] = useSearchParams();
  const open = params.get('open');
  useEffect(() => {
    if (open !== 'accounts' && open !== 'notices') return;
    dispatch({ type: 'open', panel: open });
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('open');
      return next;
    }, { replace: true });
  }, [open, dispatch, setParams]);
}

/** The office while the map loads: Luady's mark, pulsing (with reduced motion it stands still). */
function OfficeOpening() {
  return (
    <div className="agency__opening">
      <BrandMark size={56} />
      <span role="status">Opening the office…</span>
    </div>
  );
}

/**
 * The map's order for the number keys (1-9 follow `map.order`) and the empty slots the keys skip (a
 * lot's tap offers a new room there).
 */
function useOpenRooms(snapshot: AgencySnapshot) {
  const { order, rooms } = snapshot.map;
  return useMemo(() => {
    const empty = new Set(order.filter((key) => rooms[key] === undefined || isEmptySlot(rooms[key])));
    return { order, empty };
  }, [order, rooms]);
}

/** Stable callbacks for the stage: taps go to the reducer, hover to the tip, the frame's points straight to the plates and the speech layer. */
function useStageCallbacks(dispatch: Dispatch<AgencyUiAction>) {
  const navigate = useNavigate();
  const [registry] = useState(createPlateRegistry);
  const [hoverFeed] = useState(() => createFeed<StageEvent>());
  const [pointFeed] = useState(() => createFeed<readonly OverlayPoint[]>());
  const onEvent = useCallback((event: StageEvent) => {
    if (event.type === 'hover') hoverFeed.emit(event);
    else dispatch({ type: 'stage', event });
  }, [dispatch, hoverFeed]);
  const onFrame = useCallback((points: readonly OverlayPoint[]) => {
    registry.last = points;
    applyPoints(registry.nodes, points);
    pointFeed.emit(points);
  }, [registry, pointFeed]);
  const onFailed = useCallback((reason: string) => {
    void navigate(CLASSIC_PATH, { replace: true, state: officeFallbackState(reason) });
  }, [navigate]);
  const select = useCallback((id: string) => dispatch({ type: 'select', id }), [dispatch]);
  return { registry, hoverFeed, pointFeed, onEvent, onFrame, onFailed, select };
}

/**
 * The Jira pop-up of the top bar opens on the first room (in map order) with a Jira board, else the first room; null
 * while the office has no rooms (the pop-up then offers to add one).
 */
export function jiraRoomOf(snapshot: AgencySnapshot, sites: readonly string[]): string | null {
  const withBoard = new Set(sites);
  const rooms = snapshot.map.order.filter((key) => {
    const def = snapshot.map.rooms[key];
    return def !== undefined && isFurnished(def);
  });
  return rooms.find((key) => withBoard.has(key)) ?? rooms[0] ?? null;
}

/** What a welcome-back line opens: a card on the board, an agent, the agent a question waits on, or a note. */
function useRecapOpen(snapshot: AgencySnapshot, dispatch: Dispatch<AgencyUiAction>) {
  const { state } = useStore();
  const navigate = useNavigate();
  const sessions = state.sessions;
  return useCallback((ref: OfficeRef) => {
    switch (ref.kind) {
      case 'todo': {
        const id = Number(ref.id);
        dispatch({ type: 'modal', modal: Number.isInteger(id) ? { kind: 'board', itemId: id } : { kind: 'board' } });
        return;
      }
      case 'note': dispatch({ type: 'modal', modal: { kind: 'notes', noteId: ref.id } }); return;
      case 'session':
      case 'question': {
        const id = ref.kind === 'session' ? ref.id : sessions.find((session) => session.pendingQid === ref.id)?.id;
        if (id === undefined) return;
        if (Object.hasOwn(snapshot.actors, id)) dispatch({ type: 'select', id });
        else void navigate(`/sessions/${encodeURIComponent(id)}`);
      }
    }
  }, [dispatch, navigate, sessions, snapshot.actors]);
}

/** The home page: the living office map with the top bar, name plates, chat line, menu and panels over it. */
export function AgencyPage() {
  const { state } = useStore();
  const jiraRooms = useJiraSites();
  const snapshot = useAgencySnapshot(jiraRooms);
  const [ui, dispatch] = useReducer(reduceAgencyUi, INITIAL_UI);
  // The running stage's handle (null until it starts and after it goes): drag and drop asks it what is under the pointer.
  const [stageHandle, setStageHandle] = useState<StageHandle | null>(null);
  const viewport = useViewport();
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  // Day and night from the website preferences, dimmed during the owner's quiet hours.
  const ambience = useAmbience();
  const panelOpen = ui.panel !== null;
  const insets = useMemo(() => stageInsets(viewport, panelOpen), [viewport, panelOpen]);
  const chatRef = useRef<HTMLInputElement>(null);
  const rooms = useOpenRooms(snapshot);
  const stage = useStageCallbacks(dispatch);
  const luadyFlow = useLuadyFlow();
  const badges = useHudBadges(snapshot, ui.modal?.kind === 'notes');
  const jiraRoom = useMemo(() => jiraRoomOf(snapshot, jiraRooms), [snapshot, jiraRooms]);
  const accounts = useAccounts();
  const acks = useNoticeAcks();
  const panelData = useMemo(() => ({ accounts, acks }), [accounts, acks]);
  const hudDispatch = useHudDispatch(snapshot, ui, dispatch);
  const closeMenu = useCallback(() => dispatch({ type: 'close' }), []);
  const openNote = useCallback((at: ActorMenuAt) => dispatch({ type: 'note', ...at }), []);
  const welcome = useWelcomeBack();
  const openRecap = useRecapOpen(snapshot, dispatch);
  const showMe = useShowMe(stageHandle, dispatch);
  const labels = useLabelView(snapshot.map);
  const addRoom = useCallback((position: number) => dispatch({ type: 'modal', modal: { kind: 'rooms', position } }), []);
  useOfficeSounds();
  useHelpKey(dispatch);
  useGoneActors(snapshot, ui, dispatch);
  useOpenFromLink(dispatch);
  useShortcuts(rooms.order, dispatch, chatRef, rooms.empty);

  return (
    <GiveProvider stage={stageHandle} dispatch={dispatch}>
      <main className="agency" data-testid="agency-page" aria-label="Office">
        <div className="agency__stage">
          <OfficeBoundary fallback={<StageFailed onFailed={stage.onFailed} />}>
            <Suspense fallback={<OfficeOpening />}>
              <AgencyStage snapshot={snapshot} settleKey={state.overviewVersion} focus={ui.focus} selectedId={ui.selectedId} insets={insets} reducedMotion={reducedMotion}
                onEvent={stage.onEvent} onFrame={stage.onFrame} onFailed={stage.onFailed} onReady={setStageHandle} ambience={ambience}
                rooms={state.rooms} onView={labels.onView} />
            </Suspense>
          </OfficeBoundary>
        </div>
        <NamePlates snapshot={snapshot} focus={ui.focus} selectedId={ui.selectedId} registry={stage.registry} onSelect={stage.select} view={labels.view} />
        <MapLabels snapshot={snapshot} badges={badges.fixtures} plates={stage.registry} points={stage.pointFeed} insets={insets}
          view={labels.view} onAddRoom={addRoom} />
        <SpeechLayer snapshot={snapshot} registry={stage.registry} points={stage.pointFeed} insets={insets} luady={luadyFlow.flow} acks={acks}
          reducedMotion={reducedMotion} onCloseLuady={luadyFlow.close} onOpenAgent={stage.select} />
        <HoverTip snapshot={snapshot} feed={stage.hoverFeed} badges={badges.fixtures} suppressed={ui.menu !== null} />
        <TopBar snapshot={snapshot} ui={ui} dispatch={hudDispatch} live={state.connection.status === 'open'}
          tools={<HudTools modal={ui.modal} jiraRoom={jiraRoom} board={badges.board} newNotes={badges.newNotes} dispatch={dispatch} />}
          pill={<ActivityPill open={ui.modal?.kind === 'activity'} onOpen={() => dispatch({ type: 'modal', modal: { kind: 'activity' } })} />}
          extras={<TopBarExtras snapshot={snapshot} ui={ui} dispatch={dispatch} />} />
        <StatusBanners className="agency-banners" connection={state.connection.status} />
        <ChatDock inputRef={chatRef} acks={acks} onSent={luadyFlow.sent} onHeld={luadyFlow.held} onFailed={luadyFlow.close} />
        <NoticeToasts acks={acks} onSelect={stage.select} />
        <OpenPanel ui={ui} snapshot={snapshot} dispatch={dispatch} data={panelData} />
        {ui.menu ? <ActorMenu snapshot={snapshot} menu={ui.menu} onClose={closeMenu} onDetails={stage.select} onNote={openNote} /> : null}
        {ui.note ? <OpenNote at={ui.note} onClose={closeMenu} /> : null}
        {welcome.recap !== null && ui.modal === null ? <WelcomeBack recap={welcome.recap} onOpen={openRecap} onClose={welcome.dismiss} /> : null}
        <OpenModal ui={ui} dispatch={dispatch} onShow={showMe} newNotes={badges.newNotes} firstRoom={roomLookup(state.rooms).firstRoom()} />
      </main>
    </GiveProvider>
  );
}
