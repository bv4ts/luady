import type { NoticeDTO } from '@luady/shared';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoticesDrawer } from '../../../../src/features/agency/drawers/NoticesDrawer.js';
import { ChatDock } from '../../../../src/features/agency/hud/ChatDock.js';
import { NoticeToasts } from '../../../../src/features/agency/hud/NoticeToasts.js';
import { useNoticeAcks } from '../../../../src/features/agency/model/useNoticeAcks.js';
import { chat, notice } from '../../../fixtures.js';
import { fakeApi, type FakeApiOverrides } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';

function Host({ onSelect, drawer = true }: { onSelect: (id: string) => void; drawer?: boolean }) {
  const acks = useNoticeAcks();
  return (
    <>
      <NoticeToasts acks={acks} onSelect={onSelect} />
      {drawer ? <NoticesDrawer acks={acks} onSelect={onSelect} /> : null}
      <ChatDock inputRef={createRef<HTMLInputElement>()} acks={acks} />
    </>
  );
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

const fresh = (id: string, over: Partial<NoticeDTO> = {}): NoticeDTO =>
  notice({ id, createdAt: new Date().toISOString(), text: `Notice ${id}`, ...over });

async function open(over: FakeApiOverrides = {}, drawer = true) {
  const onSelect = vi.fn();
  const api = fakeApi({
    notices: async () => ({ items: [] }), activity: async () => ({ items: [] }),
    luadyMessages: async () => ({ items: [], nextCursor: null }), ...over,
  });
  const harness = await renderPage(<Host onSelect={onSelect} drawer={drawer} />, { api });
  vi.useFakeTimers();
  return { ...harness, onSelect };
}

const wait = (ms: number) => act(() => {
  vi.advanceTimersByTime(ms);
});
const acked = (calls: ReadonlyArray<readonly [readonly string[]]>) => calls.flatMap(([ids]) => [...ids]);

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('notices on the page', () => {
  it('a result toasts, and three seconds on screen in a focused tab acknowledge it once', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { ws } = await open();
    ws.emit({ type: 'notice.created', notice: fresh('n9') });
    const toast = screen.getByTestId('notice-toast');
    expect(toast.textContent).toContain('Notice n9');
    await wait(2900);
    expect(ws.client.ackNotices).not.toHaveBeenCalled();
    await wait(600);
    expect(acked(ws.client.ackNotices.mock.calls)).toEqual(['n9']);
    await wait(10_000);
    expect(ws.client.ackNotices).toHaveBeenCalledTimes(1);
  });

  it('a hidden tab acknowledges nothing; back and focused, it acknowledges 3 seconds later, once', async () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    setVisibility('hidden');
    const { ws } = await open();
    ws.emit({ type: 'notice.created', notice: fresh('n9') });
    await wait(60_000);
    expect(ws.client.ackNotices).not.toHaveBeenCalled();
    focus.mockReturnValue(true);
    setVisibility('visible');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await wait(2500);
    expect(ws.client.ackNotices).not.toHaveBeenCalled();
    await wait(1000);
    expect(acked(ws.client.ackNotices.mock.calls)).toEqual(['n9']);
    await wait(10_000);
    expect(ws.client.ackNotices).toHaveBeenCalledTimes(1);
  });

  it('a visible tab without focus does not acknowledge', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { ws } = await open();
    ws.emit({ type: 'notice.created', notice: fresh('n9') });
    await wait(10_000);
    expect(ws.client.ackNotices).not.toHaveBeenCalled();
  });

  it('a click acknowledges at once and selects the agent of its session', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { ws, onSelect } = await open();
    ws.emit({ type: 'notice.created', notice: fresh('n9', { ref: { kind: 'session', id: 'cedar:cc-meadow-hr:0.0' } }) });
    fireEvent.click(screen.getByTestId('notice-toast'));
    expect(acked(ws.client.ackNotices.mock.calls)).toEqual(['n9']);
    expect(onSelect).toHaveBeenCalledWith('cedar:cc-meadow-hr:0.0');
  });

  it('a red question or permission toasts until dismissed or answered, and is never acknowledged', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { ws } = await open();
    ws.emit({ type: 'notice.created', notice: fresh('q1', { kind: 'question', ref: { kind: 'question', id: 'ABCDEFGH' } }) });
    ws.emit({ type: 'notice.created', notice: fresh('p1', { kind: 'permission', ref: { kind: 'question', id: 'PERMITAA' } }) });
    expect(screen.getAllByTestId('notice-toast').map((t) => t.getAttribute('data-notice'))).toEqual(['p1', 'q1']);
    await wait(60_000);
    expect(ws.client.ackNotices).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('notice-toast')).toHaveLength(2);
    ws.emit({ type: 'notice.updated', notice: fresh('q1', { kind: 'question', ref: { kind: 'question', id: 'ABCDEFGH' }, settledAt: new Date().toISOString(), settledVia: 'answer' }) });
    expect(screen.getAllByTestId('notice-toast').map((t) => t.getAttribute('data-notice'))).toEqual(['p1']);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }));
    expect(screen.queryByTestId('notice-toast')).toBeNull();
    expect(ws.client.ackNotices).not.toHaveBeenCalled();
    expect(within(screen.getByTestId('notices-list')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('a result toast stays 6 seconds to be read, though it is acknowledged after 3', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { ws } = await open();
    ws.emit({ type: 'notice.created', notice: fresh('n9') });
    await wait(3500);
    expect(acked(ws.client.ackNotices.mock.calls)).toEqual(['n9']);
    ws.emit({ type: 'notice.updated', notice: fresh('n9', { settledAt: new Date().toISOString(), settledVia: 'web' }) });
    expect(screen.getByTestId('notice-toast')).toBeTruthy();
    await wait(2000);
    expect(screen.getByTestId('notice-toast')).toBeTruthy();
    await wait(700);
    expect(screen.queryByTestId('notice-toast')).toBeNull();
    expect(ws.client.ackNotices).toHaveBeenCalledTimes(1);
  });

  it('a notice already there at load does not toast but is listed', async () => {
    await open({ notices: async () => ({ items: [notice({ id: 'old', text: 'From this morning' })] }) });
    expect(screen.queryByTestId('notice-toast')).toBeNull();
    expect(within(screen.getByTestId('notices-list')).getByText('From this morning')).toBeTruthy();
  });

  it('a settled notice leaves its toast once it has shown 6 seconds; four notices show three toasts, newest on top', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { ws } = await open();
    for (const id of ['a', 'b', 'c', 'd']) ws.emit({ type: 'notice.created', notice: fresh(id) });
    const toasts = screen.getAllByTestId('notice-toast');
    expect(toasts.map((t) => t.getAttribute('data-notice'))).toEqual(['d', 'c', 'b']);
    ws.emit({ type: 'notice.updated', notice: fresh('d', { settledAt: new Date().toISOString(), settledVia: 'test-channel' }) });
    expect(screen.getAllByTestId('notice-toast').map((t) => t.getAttribute('data-notice'))).toEqual(['d', 'c', 'b']);
    await wait(6100);
    expect(screen.getAllByTestId('notice-toast').map((t) => t.getAttribute('data-notice'))).toEqual(['c', 'b', 'a']);
  });

  it('a Luady chat reply shows once: in the chat, not as a toast, and is acknowledged once it is read there', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { ws } = await open();
    ws.emit({ type: 'manager.message', message: chat({ id: 'm42', text: 'Done with the export.' }) });
    ws.emit({ type: 'notice.created', notice: fresh('r1', { kind: 'reply', ref: { kind: 'manager', id: 'm42' } }) });
    expect(screen.queryByTestId('notice-toast')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the conversation, new answers from Luady' }));
    await wait(3500);
    expect(acked(ws.client.ackNotices.mock.calls)).toEqual(['r1']);
  });

  it('a Luady chat message counts as seen only while it can be read: not while the conversation is closed', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { ws } = await open({}, false);
    ws.emit({ type: 'manager.message', message: chat({ id: 'm42', text: 'Done with the export.' }) });
    ws.emit({ type: 'notice.created', notice: fresh('r1', { kind: 'reply', ref: { kind: 'manager', id: 'm42' } }) });
    await wait(10_000);
    expect(ws.client.ackNotices).not.toHaveBeenCalled();
    // Opening the conversation shows it whole: now it is on screen.
    fireEvent.click(screen.getByRole('button', { name: 'Show the conversation, new answers from Luady' }));
    expect(screen.getByText('Done with the export.')).toBeTruthy();
    await wait(3500);
    expect(acked(ws.client.ackNotices.mock.calls)).toEqual(['r1']);
  });

  it('a result Luady started toasts as well, and its toast opens the chat', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { ws } = await open();
    ws.emit({ type: 'manager.message', message: chat({ id: 'm43', text: 'cedar/meadow-hr finished the payroll export.' }) });
    ws.emit({ type: 'notice.created', notice: fresh('r2', { kind: 'result', ref: { kind: 'manager', id: 'm43' }, text: 'cedar/meadow-hr finished the payroll export.' }) });
    const toast = screen.getByTestId('notice-toast');
    expect(toast.getAttribute('data-notice')).toBe('r2');
    fireEvent.click(within(toast).getByRole('button', { name: 'Show' }));
    expect(acked(ws.client.ackNotices.mock.calls)).toEqual(['r2']);
    expect(screen.getByTestId('location').textContent).toBe('/manager');
  });

  it('after a reconnect, an acknowledgement the hub did not settle is sent again', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { ws } = await open();
    ws.emit({ type: 'notice.created', notice: fresh('n9') });
    await wait(3500);
    expect(ws.client.ackNotices).toHaveBeenCalledTimes(1);
    ws.setStatus('open', 1);
    ws.setStatus('reconnecting', 1);
    ws.setStatus('open', 2);
    expect(acked(ws.client.ackNotices.mock.calls)).toEqual(['n9', 'n9']);
  });
});
