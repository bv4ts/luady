import '../../src/zod-csp.js';
import '../../src/styles/tokens.css';
import '../../src/styles/base.css';
import '../../src/styles/components.css';
import '../../src/styles/layout.css';
import '@fontsource/pixelify-sans/latin-500.css';
import '@fontsource/pixelify-sans/latin-600.css';
import '../../src/features/agency/agency.css';
import '../../src/features/agency/hud/kit.css';
import { StrictMode, Suspense, lazy, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { createApiClient } from '../../src/api/client.js';
import { ApiProvider } from '../../src/api/context.js';
import { AuthProvider, type AuthValue } from '../../src/auth/AuthContext.js';
import { GiveProvider } from '../../src/features/agency/give/GiveContext.js';
import { ModalFrame } from '../../src/features/agency/panels/ModalFrame.js';
import { PinProvider } from '../../src/pin/PinProvider.js';
import { StoreProvider } from '../../src/state/store.js';
import { Toasts } from '../../src/ui/Toasts.js';
import { createFakeHub, type FakeHub } from '../office/fake-hub.js';
import { createDemoWs } from '../office/fake-socket.js';
import type { SessionDTO } from '@luady/shared';
import { PROJECT_SESSIONS } from './data.js';
import { createDrawerRoutes } from './fake-routes.js';
import { createWave2Routes } from './wave2-routes.js';
import './drawers-demo.css';

/**
 * The drawers demo (`/drawers.html`): the Library and Jira pop-ups in the shared frame against a pretend hub with fixture
 * data. `?modal=library|jira`, `&jira=off` (not connected), `&jira=refused` (Jira refused the token), `&issue=ORC-1105`.
 * Any PIN works; a token containing "wrong" is refused. Also `?modal=fleet|wins|timeline|schedule|links|board`
 * (`&room=cedar` for another office's links, `&card=60` to open a board card with its reminder and due date).
 */

const params = new URLSearchParams(window.location.search);
const jiraMode = params.get('jira');
const base = createFakeHub(false);
const routes = createDrawerRoutes({ connected: jiraMode !== 'off', refused: jiraMode === 'refused' });
const wave2 = createWave2Routes();
const hub: FakeHub = {
  ...base,
  fetch: async (input, init) => {
    const url = new URL(input, window.location.origin);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    await new Promise((resolve) => setTimeout(resolve, 90));
    if (method === 'GET' && url.pathname === '/api/overview') return withProjectSessions(await base.fetch(input, init));
    if (method === 'GET' && url.pathname === '/api/board') return wave2.withCards(await base.fetch(input, init));
    const answer = wave2.handle(method, url.pathname, url.searchParams, body);
    if (answer !== null) return answer;
    return routes.handle(method, url.pathname, url.searchParams, body) ?? base.fetch(input, init);
  },
};
/** The office demo's sessions plus a few that sit in the Library's project folders, so a project shows its sessions. */
async function withProjectSessions(response: Response): Promise<Response> {
  const overview = (await response.json()) as { sessions: SessionDTO[] } & Record<string, unknown>;
  const extra = PROJECT_SESSIONS.filter((one) => !overview.sessions.some((s) => s.id === one.id));
  return new Response(JSON.stringify({ ...overview, sessions: [...overview.sessions, ...extra] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const api = createApiClient({ fetch: hub.fetch });
const auth: AuthValue = {
  me: { owner: 'owner@example.com', authMode: 'local', passkeys: 1, pinSet: true, csrf: 'demo' },
  refreshMe: async () => undefined,
  logout: async () => undefined,
  signalAuthLost: () => undefined,
};

const LibraryModal = lazy(async () => ({ default: (await import('../../src/features/agency/drawers/library/LibraryModal.js')).LibraryModal }));
const JiraModal = lazy(async () => ({ default: (await import('../../src/features/agency/drawers/jira/JiraModal.js')).JiraModal }));
const FleetModal = lazy(async () => ({ default: (await import('../../src/features/agency/drawers/fleet/FleetModal.js')).FleetModal }));
const WinsModal = lazy(async () => ({ default: (await import('../../src/features/agency/drawers/wins/WinsModal.js')).WinsModal }));
const TimelineModal = lazy(async () => ({ default: (await import('../../src/features/agency/drawers/timeline/TimelineModal.js')).TimelineModal }));
const ScheduleModal = lazy(async () => ({ default: (await import('../../src/features/agency/drawers/schedule/ScheduleModal.js')).ScheduleModal }));
const LinksModal = lazy(async () => ({ default: (await import('../../src/features/agency/drawers/links/LinksModal.js')).LinksModal }));
const BoardModal = lazy(async () => ({ default: (await import('../../src/features/agency/drawers/board/BoardModal.js')).BoardModal }));

const KINDS = ['library', 'jira', 'fleet', 'wins', 'timeline', 'schedule', 'links', 'board'] as const;
type Kind = (typeof KINDS)[number];
const LABELS: Readonly<Record<Kind, string>> = {
  library: 'Library', jira: 'Jira', fleet: 'Fleet', wins: 'Wins', timeline: 'Today', schedule: 'Schedule', links: 'Links', board: 'Board',
};
const isKind = (value: string | null): value is Kind => (KINDS as readonly (string | null)[]).includes(value);

function content(kind: Kind, close: () => void): ReactElement {
  const issue = params.get('issue');
  const card = params.get('card');
  switch (kind) {
    case 'library': return <LibraryModal onClose={close} />;
    case 'jira': return <JiraModal room="birch" {...(issue === null ? {} : { issueKey: issue })} onClose={close} />;
    case 'fleet': return <FleetModal onClose={close} />;
    case 'wins': return <WinsModal onClose={close} />;
    case 'timeline': return <TimelineModal onClose={close} />;
    case 'schedule': return <ScheduleModal onClose={close} />;
    case 'links': return <LinksModal room={params.get('room') ?? 'birch'} onClose={close} />;
    case 'board': return <BoardModal {...(card === null ? {} : { itemId: Number(card) })} onClose={close} />;
  }
}

function Demo() {
  const asked = params.get('modal');
  const [modal, setModal] = useState<Kind | null>(isKind(asked) ? asked : 'library');
  return (
    <div className="agency">
      <div className="demo-drawers__bar">
        {KINDS.map((kind) => <button key={kind} type="button" data-demo={kind} onClick={() => setModal(kind)}>{LABELS[kind]}</button>)}
      </div>
      {modal === null ? null : (
        <ModalFrame label={LABELS[modal]} onClose={() => setModal(null)}>
          <Suspense fallback={<p role="status">Opening…</p>}>{content(modal, () => setModal(null))}</Suspense>
        </ModalFrame>
      )}
    </div>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('drawers demo: #root is missing');
createRoot(root).render(
  <StrictMode>
    <ApiProvider api={api}>
      <MemoryRouter>
        <AuthProvider value={auth}>
          <StoreProvider createWs={createDemoWs(hub)} onAuthLost={() => undefined}>
            <PinProvider>
              <GiveProvider stage={null} dispatch={(action) => console.info('[demo] page action', action)}>
                <Demo />
              </GiveProvider>
              <Toasts />
            </PinProvider>
          </StoreProvider>
        </AuthProvider>
      </MemoryRouter>
    </ApiProvider>
  </StrictMode>,
);
