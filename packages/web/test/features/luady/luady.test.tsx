import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/api/errors.js';
import { LuadyPage } from '../../../src/features/luady/LuadyPage.js';
import { chat, luadyStatus, notice, overview, session } from '../../fixtures.js';
import { fakeApi } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';

const emptyThread = async () => ({ items: [], nextCursor: null });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LuadyPage', () => {
  it('loads the thread and tags messages by channel', async () => {
    const api = fakeApi({
      luadyMessages: async () => ({
        items: [
          chat({ id: 'm1', role: 'owner', channel: 'test-channel', text: 'status?', ts: '2026-10-09T11:59:00.000Z' }),
          chat({ id: 'm2', role: 'manager', channel: 'test-channel', text: '**All good.** 3 sessions running.' }),
        ],
        nextCursor: null,
      }),
    });
    await renderPage(<LuadyPage />, { api });
    expect(await screen.findByText('status?')).toBeTruthy();
    expect(screen.getByText('All good.').tagName).toBe('STRONG');
    expect(screen.getAllByText('Chat', { selector: '.chip' })).toHaveLength(2);
    expect(api.luadyMessages).toHaveBeenCalledWith(null, 50);
  });

  it('sends a message with an optimistic bubble that the echo replaces', async () => {
    const api = fakeApi({ luadyMessages: emptyThread, sendToLuady: async () => ({ ok: true }) });
    const { user, ws } = await renderPage(<LuadyPage />, { api });
    await user.type(screen.getByLabelText('Message to Luady'), 'check cedar disk');
    await user.click(screen.getByRole('button', { name: 'Send to Luady' }));
    expect(api.sendToLuady).toHaveBeenCalledWith({ text: 'check cedar disk' });
    expect(await screen.findByText('Sent')).toBeTruthy();
    ws.emit({ type: 'manager.message', message: chat({ id: 'm9', role: 'owner', channel: 'web', text: 'check cedar disk' }) });
    expect(screen.getAllByText('check cedar disk')).toHaveLength(1);
    expect(screen.queryByText('Sent')).toBeNull();
    ws.emit({ type: 'manager.message', message: chat({ id: 'm10', role: 'manager', channel: 'web', text: 'cedar has 20 GB free.' }) });
    expect(screen.getByText('cedar has 20 GB free.')).toBeTruthy();
  });

  it('does not double-render when the echo arrives before the send resolves', async () => {
    let finish: (value: { ok: true }) => void = () => undefined;
    const api = fakeApi({
      luadyMessages: emptyThread,
      sendToLuady: () => new Promise<{ ok: true }>((resolve) => { finish = resolve; }),
    });
    const { user, ws } = await renderPage(<LuadyPage />, { api });
    await user.type(screen.getByLabelText('Message to Luady'), 'check cedar disk');
    await user.click(screen.getByRole('button', { name: 'Send to Luady' }));
    expect(screen.getByText('Sending…')).toBeTruthy();
    ws.emit({ type: 'manager.message', message: chat({ id: 'm9', role: 'owner', channel: 'web', text: 'check cedar disk' }) });
    expect(screen.getAllByText('check cedar disk')).toHaveLength(1);
    await act(async () => { finish({ ok: true }); });
    expect(screen.getAllByText('check cedar disk')).toHaveLength(1);
    expect(screen.queryByText('Sending…')).toBeNull();
    expect(screen.queryByText('Sent')).toBeNull();
    ws.emit({ type: 'manager.message', message: chat({ id: 'm9', role: 'owner', channel: 'web', text: 'check cedar disk' }) });
    expect(screen.getAllByText('check cedar disk')).toHaveLength(1);
  });

  it('restores the text when sending fails', async () => {
    const api = fakeApi({
      luadyMessages: emptyThread,
      sendToLuady: async () => { throw new ApiError(503, 'http_503', 'Luady answered with HTTP 503.'); },
    });
    const { user } = await renderPage(<LuadyPage />, { api });
    await user.type(screen.getByLabelText('Message to Luady'), 'hello');
    await user.click(screen.getByRole('button', { name: 'Send to Luady' }));
    await waitFor(() => expect((screen.getByLabelText('Message to Luady') as HTMLTextAreaElement).value).toBe('hello'));
    expect(screen.getByRole('alert').textContent).toMatch(/unreachable/);
  });

  it('never sends PIN-looking text to Luady', async () => {
    const api = fakeApi({ luadyMessages: emptyThread, sendToLuady: async () => ({ ok: true }) });
    const { user } = await renderPage(<LuadyPage />, { api });
    await user.type(screen.getByLabelText('Message to Luady'), '٤٨٢٩١٧');
    await user.click(screen.getByRole('button', { name: 'Send to Luady' }));
    expect(screen.getByRole('alert').textContent).toMatch(/looks like a PIN/);
    expect(api.sendToLuady).not.toHaveBeenCalled();
  });

  it('shows the Luady status from the overview and live updates', async () => {
    const api = fakeApi({ luadyMessages: emptyThread });
    const { ws } = await renderPage(<LuadyPage />, { api, overview: overview({ manager: luadyStatus({ state: 'running' }) }) });
    expect(screen.getByText('Ready')).toBeTruthy();
    ws.emit({ type: 'manager.status', status: luadyStatus({ state: 'busy', queued: 2 }) });
    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(screen.getByText('2 queued')).toBeTruthy();
  });

  it('browses memory files read-only', async () => {
    const api = fakeApi({
      luadyMessages: emptyThread,
      memoryFiles: async () => ({ files: [{ name: 'journal/2026-10-08.md', size: 900 }, { name: 'USER.md', size: 120 }] }),
      memoryFile: async (name) => ({ name, content: '# Owner\n\nPrefers short replies.' }),
    });
    const { user } = await renderPage(<LuadyPage />, { api });
    await user.click(screen.getByRole('tab', { name: 'Memory' }));
    await user.click(await screen.findByRole('button', { name: /USER\.md/ }));
    expect(api.memoryFile).toHaveBeenCalledWith('USER.md');
    expect(await screen.findByRole('heading', { name: 'Owner' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'All files' }));
    expect(screen.getByRole('button', { name: /journal\/2026-10-08\.md/ })).toBeTruthy();
  });

  it('a message the hub holds while Luady is signed out says so, until Luady answers again', async () => {
    const api = fakeApi({ luadyMessages: emptyThread, sendToLuady: async () => ({ ok: true as const, held: true }) });
    const { user, ws } = await renderPage(<LuadyPage />, { api });
    await user.type(screen.getByLabelText('Message to Luady'), 'check cedar disk');
    await user.click(screen.getByRole('button', { name: 'Send to Luady' }));
    expect(await screen.findByText('Luady is signed out. Your message is kept and passed on after sign-in.')).toBeTruthy();
    ws.emit({ type: 'manager.message', message: chat({ id: 'm10', role: 'manager', channel: 'web', text: 'Back. cedar has 20 GB free.', ts: new Date(Date.now() + 1000).toISOString() }) });
    expect(screen.queryByText('Luady is signed out. Your message is kept and passed on after sign-in.')).toBeNull();
  });

  it('a held message that comes back over the socket leaves no pending bubble behind', async () => {
    const api = fakeApi({ luadyMessages: emptyThread, sendToLuady: async () => ({ ok: true as const, held: true }) });
    const { user, ws } = await renderPage(<LuadyPage />, { api });
    await user.type(screen.getByLabelText('Message to Luady'), 'check cedar disk');
    await user.click(screen.getByRole('button', { name: 'Send to Luady' }));
    await screen.findByText('Luady is signed out. Your message is kept and passed on after sign-in.');
    ws.emit({ type: 'manager.message', message: chat({ id: 'm9', role: 'owner', channel: 'web', text: 'check cedar disk' }) });
    expect(screen.getAllByText('check cedar disk')).toHaveLength(1);
    expect(screen.queryByText('Sent')).toBeNull();
    expect(screen.queryByText('Sending…')).toBeNull();
    expect(screen.getByText('Luady is signed out. Your message is kept and passed on after sign-in.')).toBeTruthy();
  });

  it('a plain accepted answer shows no held line', async () => {
    const api = fakeApi({ luadyMessages: emptyThread, sendToLuady: async () => ({ ok: true }) });
    const { user } = await renderPage(<LuadyPage />, { api });
    await user.type(screen.getByLabelText('Message to Luady'), 'check cedar disk');
    await user.click(screen.getByRole('button', { name: 'Send to Luady' }));
    expect(await screen.findByText('Sent')).toBeTruthy();
    expect(screen.queryByText(/kept and passed on/)).toBeNull();
  });

  it('a Luady reply read on this page counts as seen after 3 seconds in a focused tab', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const api = fakeApi({
      luadyMessages: async () => ({ items: [chat({ id: 'm2', role: 'manager', channel: 'web', text: 'cedar has 20 GB free.' })], nextCursor: null }),
      notices: async () => ({ items: [notice({ id: 'r1', kind: 'reply', ref: { kind: 'manager', id: 'm2' }, text: 'cedar has 20 GB free.' })] }),
    });
    const { ws } = await renderPage(<LuadyPage />, { api });
    await screen.findByText('cedar has 20 GB free.');
    expect(ws.client.ackNotices).not.toHaveBeenCalled();
    await waitFor(() => expect(ws.client.ackNotices.mock.calls.flatMap(([ids]) => [...ids])).toEqual(['r1']), { timeout: 5_000 });
  });

  it('switched off: a calm note with the way to the switch, no alarm, and the composer waits', async () => {
    const api = fakeApi({ luadyMessages: emptyThread, sendToLuady: async () => ({ ok: true }) });
    const { ws } = await renderPage(<LuadyPage />, { api, overview: overview({ manager: luadyStatus({ state: 'off' }) }) });
    const hint = screen.getByTestId('manager-off');
    expect(hint.textContent).toBe('Luady is off. Turn it on in Settings.');
    expect(within(hint).getByRole('link', { name: 'Turn it on in Settings' }).getAttribute('href')).toBe('/settings');
    const pill = screen.getByText('Switched off');
    expect(pill.className).toBe('badge tone-ended');
    expect(screen.queryByText('Down')).toBeNull();
    expect(screen.queryByText('Off')).toBeNull();
    expect((screen.getByLabelText('Message to Luady') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Send to Luady' }) as HTMLButtonElement).disabled).toBe(true);
    ws.emit({ type: 'manager.status', status: luadyStatus({ state: 'running' }) });
    expect(await screen.findByText('Ready')).toBeTruthy();
    expect(screen.queryByTestId('manager-off')).toBeNull();
    expect((screen.getByLabelText('Message to Luady') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('a send refused because the manager was just switched off says so in plain words', async () => {
    const api = fakeApi({ luadyMessages: emptyThread, sendToLuady: async () => { throw new ApiError(409, 'manager_off', 'manager_off'); } });
    const { user } = await renderPage(<LuadyPage />, { api });
    await user.type(screen.getByLabelText('Message to Luady'), 'hello');
    await user.click(screen.getByRole('button', { name: 'Send to Luady' }));
    expect(await screen.findByText('Luady is off. Turn it on in Settings.')).toBeTruthy();
    expect(screen.queryByText('manager_off')).toBeNull();
  });

  it('names no chat app in its words', async () => {
    await renderPage(<LuadyPage />, { api: fakeApi({ luadyMessages: emptyThread }) });
    expect(document.body.textContent).not.toMatch(/whatsapp/i);
    expect(screen.getByText(/shared with your chat channel/)).toBeTruthy();
  });

  it('lists missions started by Luady', async () => {
    const mission = session({ id: 'birch:cc-mission:0.0', host: 'birch', displayName: 'orchard-audit', origin: 'manager', cwd: '/home/dev/projects/orchard' });
    const api = fakeApi({ luadyMessages: emptyThread });
    const { user } = await renderPage(<LuadyPage />, { api, overview: overview({ sessions: [session(), mission] }) });
    await user.click(screen.getByRole('tab', { name: 'Missions (1)' }));
    expect(screen.getByRole('link', { name: /orchard-audit/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /meadow-hr/ })).toBeNull();
  });
});
