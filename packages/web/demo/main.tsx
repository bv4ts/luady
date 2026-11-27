import { buildSnapshot, type AgencySnapshot } from '@luady/office';
import type { LuadyStatusDTO, HostId, SessionDTO } from '@luady/shared';
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AgencyStage from '../src/features/agency/scene/AgencyStage.js';
import type { OverlayPoint, StageEvent, StageFocus, StageInsets } from '../src/features/agency/stage-types.js';
import { DEMO_HOSTS, DEMO_ROOMS, DEMO_SERVERS, demoLuady, demoSessions, freshSession, nextState } from './fixtures.js';
import { createPlates } from './plates.js';
import './demo.css';

/** Development page for the office scene: fixture data, a control strip and a read-out of stage events. */

declare global {
  interface Window { __agencyDemo?: { actors(): number; events: StageEvent[]; failed: string | null } }
}

const STRIP_PX = 64;
const NARROW_PX = 760;
const events: StageEvent[] = [];
const probe: { snapshot: AgencySnapshot | null; failed: string | null } = { snapshot: null, failed: null };
window.__agencyDemo = { actors: () => Object.keys(probe.snapshot?.actors ?? {}).length, events, failed: null };

interface World { readonly sessions: readonly SessionDTO[]; readonly luady: LuadyStatusDTO['state']; readonly snapshot: AgencySnapshot }

const build = (sessions: readonly SessionDTO[], luady: LuadyStatusDTO['state'], previous: AgencySnapshot | null): AgencySnapshot =>
  buildSnapshot({ servers: DEMO_SERVERS, rooms: DEMO_ROOMS, sessions, questions: [], luady: demoLuady(luady), now: Date.now(), previousSeats: previous?.seats ?? {} });

const initialWorld = (): World => {
  const sessions = demoSessions();
  return { sessions, luady: 'running', snapshot: build(sessions, 'running', null) };
};

const describe = (e: StageEvent): string => {
  if (e.type === 'actor') return `actor ${e.id}`;
  if (e.type === 'room') return `room ${e.room ?? '(outside)'}`;
  if (e.type === 'menu') return `menu ${e.id} at ${Math.round(e.x)},${Math.round(e.y)}`;
  if (e.type === 'fixture') return `${e.fixture} ${e.room}`;
  return `hover ${e.id ?? '(none)'}`;
};

function useWindowSize(): { readonly width: number; readonly height: number } {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const onResize = (): void => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

function Demo() {
  const [world, setWorld] = useState(initialWorld);
  const [focus, setFocus] = useState<StageFocus>({ kind: 'all' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [panel, setPanel] = useState(false);
  const [room, setRoom] = useState<HostId>('birch');
  const [log, setLog] = useState<readonly string[]>([]);
  const size = useWindowSize();
  const platesRef = useRef<ReturnType<typeof createPlates> | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  probe.snapshot = world.snapshot;

  useEffect(() => {
    const layer = layerRef.current;
    if (layer === null) return undefined;
    platesRef.current = createPlates(layer);
    return () => platesRef.current?.clear();
  }, []);

  const narrow = size.width < NARROW_PX;
  const insets: StageInsets = {
    top: STRIP_PX, left: 0,
    right: panel && !narrow ? 360 : 0,
    bottom: panel && narrow ? Math.round(size.height * 0.56) : 0,
  };

  const change = useCallback((edit: (sessions: readonly SessionDTO[]) => readonly SessionDTO[], luady?: LuadyStatusDTO['state']) => {
    setWorld((prev) => {
      const sessions = edit(prev.sessions);
      const nextLuady = luady ?? prev.luady;
      return { sessions, luady: nextLuady, snapshot: build(sessions, nextLuady, prev.snapshot) };
    });
  }, []);

  const target = (): string | null => selectedId ?? world.sessions.at(-1)?.id ?? null;
  const add = (): void => change((list) => [...list, freshSession(room, new Set(list.map((s) => s.id)))]);
  const end = (): void => {
    const id = target();
    change((list) => list.filter((s) => s.id !== id));
    if (id === selectedId) setSelectedId(null);
  };
  const cycle = (): void => {
    const id = target();
    change((list) => list.map((s) => (s.id === id ? { ...s, state: nextState(s.state), lastEventAt: new Date().toISOString() } : s)));
  };

  const onEvent = useCallback((e: StageEvent) => {
    events.push(e);
    if (e.type === 'hover') return;
    setLog((prev) => [describe(e), ...prev].slice(0, 4));
    if (e.type === 'actor') {
      setSelectedId(e.id);
      setFocus({ kind: 'actor', id: e.id });
    } else if (e.type === 'room') {
      setSelectedId(null);
      setFocus(e.room === null ? { kind: 'all' } : { kind: 'room', room: e.room });
    } else if (e.type === 'fixture') {
      setFocus({ kind: 'room', room: e.room });
    } else {
      setSelectedId(e.id);
    }
  }, []);

  const onFrame = useCallback((points: readonly OverlayPoint[]) => {
    platesRef.current?.place(points, probe.snapshot);
  }, []);

  const onFailed = useCallback((reason: string) => {
    probe.failed = reason;
    if (window.__agencyDemo) window.__agencyDemo.failed = reason;
    setLog((prev) => [`FAILED: ${reason}`, ...prev]);
  }, []);

  return (
    <>
      <div className="demo-stage">
        <AgencyStage snapshot={world.snapshot} settleKey={1} focus={focus} selectedId={selectedId} insets={insets} reducedMotion={reduced}
          onEvent={onEvent} onFrame={onFrame} onFailed={onFailed} />
        <div className="demo-plates" ref={layerRef} />
      </div>
      {panel && <div className={narrow ? 'demo-panel demo-sheet' : 'demo-panel demo-dock'}>Panel ({narrow ? 'sheet' : 'dock'})</div>}
      <div className="demo-strip">
        <div className="demo-row">
          <select aria-label="Room" value={room} onChange={(e) => setRoom(e.target.value as HostId)}>
            {DEMO_HOSTS.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
          <button type="button" data-demo="add" onClick={add}>Add</button>
          <button type="button" data-demo="end" onClick={end}>End</button>
          <button type="button" data-demo="cycle" onClick={cycle}>Cycle state</button>
          <button type="button" data-demo="focus-all" onClick={() => { setFocus({ kind: 'all' }); setSelectedId(null); }}>All</button>
          {[...DEMO_HOSTS, 'hq'].map((r) => (
            <button key={r} type="button" data-demo={`focus-${r}`} aria-pressed={focus.kind === 'room' && focus.room === r} onClick={() => setFocus({ kind: 'room', room: r })}>{r}</button>
          ))}
          <button type="button" data-demo="manager" onClick={() => change((l) => l, world.luady === 'busy' ? 'running' : 'busy')}>Luady {world.luady}</button>
          <label><input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} /> reduced</label>
          <label><input type="checkbox" data-demo="panel" checked={panel} onChange={(e) => setPanel(e.target.checked)} /> panel</label>
        </div>
        <output className="demo-log" data-demo="log">{log.join(' · ') || 'Tap a room or a character.'}</output>
      </div>
    </>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('demo: #root is missing');
createRoot(root).render(<StrictMode><Demo /></StrictMode>);
