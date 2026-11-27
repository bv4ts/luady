import { randomUUID } from 'node:crypto';
import type { SessionDetailDTO, SessionDTO } from '@luady/shared';
import type { FakeLogEntry, FakeServer } from './docker.js';
import type { TestHub } from './hub.js';
import { waitFor } from './wait.js';

/** Must match QUESTION_COLOR / QUESTION_EXTRAS in tests/integration/fake-server/fake_claude.py. */
export const QUESTION_TEXT = 'Which color should the button be?';
export const EXTRAS_TEXT = 'Which extras do you want?';

export function waitForLog(server: FakeServer, match: (e: FakeLogEntry) => boolean, what: string, timeoutMs = 45_000): Promise<FakeLogEntry> {
  return waitFor(async () => (await server.fakeLog()).find(match), { timeoutMs, intervalMs: 300, what });
}

export function waitForSession(hub: TestHub, id: string, match: (s: SessionDTO) => boolean, what: string, timeoutMs = 60_000): Promise<SessionDTO> {
  return waitFor(() => {
    const session = hub.app.services.sessions.get(id);
    return session !== undefined && match(session) ? session : undefined;
  }, { timeoutMs, what });
}

/** Polls the activity service's live detail for a session until `match` holds (steps, helpers, meters, pause). */
export function waitForActivity(
  hub: TestHub,
  sessionId: string,
  match: (d: SessionDetailDTO) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<SessionDetailDTO> {
  // A short interval catches brief states, e.g. a helper that lives only within a turn.
  return waitFor(() => {
    const detail = hub.app.services.activity.detail(sessionId);
    return match(detail) ? detail : undefined;
  }, { timeoutMs, intervalMs: 100, what });
}

/** tmux send-keys -l + Enter as user dev — the owner typing in the terminal. */
export async function typeInto(server: FakeServer, target: string, text: string): Promise<void> {
  await server.typeInto(target, text);
}

/** Appends one notification event through the real kit hook (no tmux pane, so it maps to no session). */
export async function appendSentinel(server: FakeServer, token: string): Promise<void> {
  const payload = {
    session_id: `luady-it-sentinel-${token}`, transcript_path: '/dev/null', cwd: '/home/dev',
    hook_event_name: 'Notification', message: `luady-it sentinel ${token}`, title: null, notification_type: 'luady_it_sentinel',
  };
  await server.execOk('dev', 'python3 "$HOME/.luady/hooks/luady_hook.py"', JSON.stringify(payload));
}

/** Resolves once the hub's cedar event stream is live, whatever offset the ingester started from. */
export async function syncStream(hub: TestHub, server: FakeServer, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = randomUUID();
    await appendSentinel(server, token);
    const seen = await waitFor(
      () => hub.spool.some((r) => r.host === 'cedar' && JSON.stringify(r.event).includes(token)),
      { timeoutMs: 5_000, what: 'sentinel event' },
    ).catch(() => false);
    if (seen) return;
  }
  throw new Error('the hub never ingested a sentinel event from cedar (is the fleet connecting?)');
}
