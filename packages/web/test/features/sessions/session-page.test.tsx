import type { OverviewDTO } from '@luady/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SessionPage } from '../../../src/features/sessions/SessionPage.js';
import { action, item, overview, question, session } from '../../fixtures.js';
import { fakeApi, type FakeApi, type FakeApiOverrides } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';

const SID = 'cedar:cc-meadow-hr:0.0';
const ROUTE = `/sessions/${encodeURIComponent(SID)}`;

function transcriptApi(over: FakeApiOverrides = {}): FakeApi {
  return fakeApi({
    transcript: async (_id, cursor) => (cursor === 'c1'
      ? { items: [item({ uuid: 'u0', role: 'user', text: 'older message' })], nextCursor: null }
      : {
        items: [
          item({ uuid: 'u1', role: 'user', text: 'Fix the login bug' }),
          item({ uuid: 'u2', role: 'tool', toolName: 'Bash', text: 'npm test\n42 passing' }),
          item({ uuid: 'u3', text: '**Done.** All tests pass.' }),
        ],
        nextCursor: 'c1',
      }),
    ...over,
  });
}

const open = (api: FakeApi, state?: OverviewDTO) =>
  renderPage(<SessionPage />, { api, route: ROUTE, path: '/sessions/:id', ...(state ? { overview: state } : {}) });

describe('SessionPage', () => {
  it('loads the newest page, subscribes and renders each role', async () => {
    const api = transcriptApi();
    const { ws } = await open(api);
    expect(await screen.findByText('Fix the login bug')).toBeTruthy();
    expect(api.transcript).toHaveBeenCalledWith(SID, null, 50);
    expect(ws.subscriptions.get(SID)).toBe(1);
    expect(screen.getByText('Done.').tagName).toBe('STRONG');
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
  });

  it('loads earlier messages with the cursor', async () => {
    const api = transcriptApi();
    const { user } = await open(api);
    await user.click(await screen.findByRole('button', { name: 'Load earlier messages' }));
    const older = await screen.findByText('older message');
    expect(api.transcript).toHaveBeenCalledWith(SID, 'c1', 50);
    expect(older.compareDocumentPosition(screen.getByText('Fix the login bug')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Start of the transcript')).toBeTruthy();
  });

  it('appends live transcript items without duplicates', async () => {
    const { ws } = await open(transcriptApi());
    await screen.findByText('Fix the login bug');
    ws.emit({
      type: 'transcript.appended', sessionId: SID,
      items: [item({ uuid: 'u3', text: '**Done.** All tests pass.' }), item({ uuid: 'u4', role: 'user', text: 'now deploy' })],
    });
    expect(screen.getByText('now deploy')).toBeTruthy();
    expect(screen.getAllByText('Done.')).toHaveLength(1);
  });

  it('renders a transcript XSS payload inert', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script> [x](javascript:alert(3))';
    await open(transcriptApi({ transcript: async () => ({ items: [item({ uuid: 'x1', text: payload })], nextCursor: null }) }));
    const log = await screen.findByRole('log', { name: 'Transcript' });
    await waitFor(() => expect(log.textContent).toContain('alert(1)'));
    expect(log.querySelector('script, img')).toBeNull();
    const attributes = [...log.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((attr) => `${attr.name}=${attr.value}`));
    expect(attributes.filter((entry) => /^on/i.test(entry) || /javascript:/i.test(entry))).toEqual([]);
  });

  it('sends a message to the session', async () => {
    const api = transcriptApi({ sendToSession: async () => action({ kind: 'session.send', tier: 0, status: 'done' }) });
    const { user } = await open(api);
    const input = screen.getByTestId('session-send-input') as HTMLTextAreaElement;
    expect(input.tagName).toBe('TEXTAREA');
    expect(input).toBe(screen.getByLabelText('Message to meadow-hr'));
    await user.type(input, 'run the tests{Enter}$(whoami) "quoted"');
    const send = screen.getByTestId('session-send-button');
    expect(send).toBe(screen.getByRole('button', { name: 'Send' }));
    await user.click(send);
    expect(api.sendToSession).toHaveBeenCalledWith(SID, { text: 'run the tests\n$(whoami) "quoted"' });
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('stop asks for the PIN first', async () => {
    const api = transcriptApi({ stopSession: async () => action({ kind: 'session.stop', status: 'done', result: 'stopped', actor: 'owner', channel: 'web' }) });
    const { user } = await open(api);
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop cedar · meadow-hr' });
    await user.type(within(dialog).getByLabelText('PIN'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.stopSession).toHaveBeenCalledWith(SID, { pin: '123456', force: false }));
    expect(await screen.findByText('#A7 done: stopped')).toBeTruthy();
  });

  it('interrupts the current turn without a PIN', async () => {
    const api = transcriptApi({ interruptSession: async () => action({ kind: 'session.interrupt', tier: 0, status: 'done', result: 'Escape sent' }) });
    const { user } = await open(api);
    await user.click(screen.getByRole('button', { name: 'Interrupt' }));
    expect(api.interruptSession).toHaveBeenCalledWith(SID);
    expect(await screen.findByText('#A7 done: Escape sent')).toBeTruthy();
  });

  it('opens the terminal for this pane', async () => {
    const { user } = await open(transcriptApi());
    await user.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.getByTestId('location').textContent).toBe('/terminal/cedar?target=cc-meadow-hr%3A0.0');
  });

  it('shows the pending question inline and blocks sending', async () => {
    const waiting = session({ state: 'waiting_question', pendingQid: 'ABCDEFGH' });
    await open(transcriptApi(), overview({ sessions: [waiting], questions: [question()] }));
    expect(screen.getByRole('article', { name: 'Question #ABCDEFGH' })).toBeTruthy();
    expect((screen.getByLabelText('Message to meadow-hr') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('says when the session does not exist', async () => {
    await renderPage(<SessionPage />, { api: transcriptApi(), route: '/sessions/cedar%3Acc-gone%3A0.0', path: '/sessions/:id' });
    expect(screen.getByText('Session not found')).toBeTruthy();
  });

  it('unsubscribes when leaving the page', async () => {
    const { ws, unmount } = await open(transcriptApi());
    await screen.findByText('Fix the login bug');
    unmount();
    expect(ws.subscriptions.size).toBe(0);
  });
});
