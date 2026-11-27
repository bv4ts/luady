import { act, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChatDock, cardFromText } from '../../../../src/features/agency/hud/ChatDock.js';
import { HoverTip } from '../../../../src/features/agency/hud/HoverTip.js';
import { createFeed } from '../../../../src/features/agency/model/feed.js';
import { LUADY_ACTOR_ID, type StageEvent } from '../../../../src/features/agency/stage-types.js';
import { chat, luadyStatus, overview } from '../../../fixtures.js';
import { fakeApi } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { snapshotOf } from '../agency-fixtures.js';

const LONG = `Here is the plan for the payroll export:\n\n1. Switch the CSV to ISO dates.\n2. ${'Update the tests and the README. '.repeat(12)}`;

const THREAD = [
  chat({ id: 'm1', role: 'owner', text: 'first' }),
  chat({ id: 'm2', role: 'manager', text: 'second' }),
  chat({ id: 'm3', role: 'owner', text: 'third', about: { kind: 'note', id: 'm:abc', label: 'Weekly sync' } }),
  chat({ id: 'm4', role: 'manager', text: LONG }),
];

function chatApi(over: Parameters<typeof fakeApi>[0] = {}) {
  return fakeApi({ luadyMessages: async () => ({ items: THREAD, nextCursor: null }), sendToLuady: async () => ({ ok: true }), ...over });
}

const toggle = (name: RegExp) => screen.getByRole('button', { name });

describe('ChatDock', () => {
  it('closed it is the input with a chat button; open it shows the whole conversation with full messages', async () => {
    const { user } = await renderPage(<ChatDock inputRef={createRef()} />, { api: chatApi() });
    expect(screen.queryByRole('log')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message to Luady' })).toBeTruthy();
    await user.click(toggle(/^Show the conversation/));
    const log = screen.getByRole('log', { name: 'Messages with Luady' });
    const items = Array.from(log.children);
    expect(items).toHaveLength(4);
    // Nothing is cut: Luady's long answer is there in full, as Markdown.
    expect(items[3]?.textContent).toContain('Update the tests and the README. '.repeat(12).trim());
    expect(within(items[3] as HTMLElement).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Full chat page' }).getAttribute('href')).toBe('/manager');
    await user.click(screen.getAllByRole('button', { name: 'Hide the conversation' })[0] as HTMLElement);
    expect(screen.queryByRole('log')).toBeNull();
  });

  it('shows what a message is about', async () => {
    const { user } = await renderPage(<ChatDock inputRef={createRef()} />, { api: chatApi() });
    await user.click(toggle(/^Show the conversation/));
    expect(screen.getByText('Note: Weekly sync')).toBeTruthy();
  });

  it('a dot marks answers that came while it was closed; opening reads them', async () => {
    const { user, ws } = await renderPage(<ChatDock inputRef={createRef()} />, { api: chatApi() });
    await vi.waitFor(() => expect(toggle(/^Show the conversation$/)).toBeTruthy());
    act(() => ws.emit({ type: 'manager.message', message: chat({ id: 'm5', role: 'manager', text: 'Done.' }) }));
    expect(toggle(/new answers from Luady/).getAttribute('data-unread')).toBe('true');
    // The owner's own message is no answer.
    await user.click(toggle(/new answers/));
    await user.click(screen.getAllByRole('button', { name: 'Hide the conversation' })[0] as HTMLElement);
    act(() => ws.emit({ type: 'manager.message', message: chat({ id: 'm6', role: 'owner', text: 'ok' }) }));
    expect(toggle(/^Show the conversation$/)).toBeTruthy();
  });

  it("Luady's NO_UPDATE (a background turn with nothing for the owner) is not shown and lights no dot", async () => {
    const { user, ws } = await renderPage(<ChatDock inputRef={createRef()} />, { api: chatApi() });
    await vi.waitFor(() => expect(toggle(/^Show the conversation$/)).toBeTruthy());
    act(() => ws.emit({ type: 'manager.message', message: chat({ id: 'm7', role: 'manager', text: '**NO_UPDATE**' }) }));
    expect(toggle(/^Show the conversation$/).getAttribute('data-unread')).not.toBe('true');
    await user.click(toggle(/^Show the conversation$/));
    const log = screen.getByRole('log', { name: 'Messages with Luady' });
    expect(log.textContent).not.toContain('NO_UPDATE');
    expect(Array.from(log.children)).toHaveLength(4);
  });

  it('Esc closes the conversation from inside it', async () => {
    const { user } = await renderPage(<ChatDock inputRef={createRef()} />, { api: chatApi() });
    await user.click(toggle(/^Show the conversation/));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('log')).toBeNull();
  });

  it('sends with Enter through the API, clears the input and says it went out', async () => {
    const api = chatApi();
    const onSent = vi.fn();
    const { user } = await renderPage(<ChatDock inputRef={createRef()} onSent={onSent} />, { api });
    const input = screen.getByRole('textbox', { name: 'Message to Luady' });
    await user.type(input, 'check cedar disk{Enter}');
    expect(api.sendToLuady).toHaveBeenCalledWith({ text: 'check cedar disk' });
    expect(onSent).toHaveBeenCalledTimes(1);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('a message the hub keeps while Luady is signed out is passed on and said in the conversation', async () => {
    const api = chatApi({ sendToLuady: async () => ({ ok: true as const, held: true }) });
    const onHeld = vi.fn();
    const { user } = await renderPage(<ChatDock inputRef={createRef()} onHeld={onHeld} />, { api });
    await user.type(screen.getByRole('textbox', { name: 'Message to Luady' }), 'check cedar disk{Enter}');
    await vi.waitFor(() => expect(onHeld).toHaveBeenCalled());
    await user.click(toggle(/^Show the conversation/));
    expect(screen.getByText('Luady is signed out. Your message is kept and passed on after sign-in.')).toBeTruthy();
  });

  it('the menu adds the text to the board instead of sending it', async () => {
    const api = chatApi({ createCard: async () => ({ ...cardStub(), id: 12 }) });
    const { user } = await renderPage(<ChatDock inputRef={createRef()} />, { api });
    await user.type(screen.getByRole('textbox', { name: 'Message to Luady' }), 'Buy milk');
    await user.click(screen.getByRole('button', { name: 'More ways to send' }));
    await user.click(screen.getByRole('menuitem', { name: 'Add to board' }));
    expect(api.createCard).toHaveBeenCalledWith({ title: 'Buy milk', source: 'web' });
    expect(api.sendToLuady).not.toHaveBeenCalled();
    expect(await screen.findByText('Added to the board as #12.')).toBeTruthy();
  });

  it('the menu can also send to Luady', async () => {
    const api = chatApi();
    const { user } = await renderPage(<ChatDock inputRef={createRef()} />, { api });
    await user.type(screen.getByRole('textbox', { name: 'Message to Luady' }), 'hello');
    await user.click(screen.getByRole('button', { name: 'More ways to send' }));
    await user.click(screen.getByRole('menuitem', { name: 'Send to Luady' }));
    expect(api.sendToLuady).toHaveBeenCalledWith({ text: 'hello' });
  });

  it('never sends something that looks like a PIN, nor adds it to the board', async () => {
    const api = chatApi();
    const { user } = await renderPage(<ChatDock inputRef={createRef()} />, { api });
    await user.type(screen.getByRole('textbox', { name: 'Message to Luady' }), '246813{Enter}');
    expect(api.sendToLuady).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('looks like a PIN');
    await user.click(screen.getByRole('button', { name: 'More ways to send' }));
    await user.click(screen.getByRole('menuitem', { name: 'Add to board' }));
    expect(api.createCard).not.toHaveBeenCalled();
  });

  it('keeps the text when sending fails and says so', async () => {
    const api = fakeApi({ luadyMessages: async () => ({ items: [], nextCursor: null }), sendToLuady: async () => { throw new Error('offline'); } });
    const onFailed = vi.fn();
    const { user } = await renderPage(<ChatDock inputRef={createRef()} onFailed={onFailed} />, { api });
    const input = screen.getByRole('textbox', { name: 'Message to Luady' }) as HTMLInputElement;
    await user.type(input, 'hello{Enter}');
    await vi.waitFor(() => expect(input.value).toBe('hello'));
    expect(onFailed).toHaveBeenCalled();
  });

  it('an empty conversation says what to do', async () => {
    const api = fakeApi({ luadyMessages: async () => ({ items: [], nextCursor: null }) });
    const { user } = await renderPage(<ChatDock inputRef={createRef()} />, { api });
    await user.click(toggle(/^Show the conversation/));
    expect(screen.getByText('Say hi to Luady')).toBeTruthy();
  });
});

describe('ChatDock with the manager switched off', () => {
  it('says so calmly with the way to the switch; the input waits; the history still opens', async () => {
    const api = chatApi();
    const { user, ws } = await renderPage(<ChatDock inputRef={createRef()} />, { api, overview: overview({ manager: luadyStatus({ state: 'off' }) }) });
    const hint = screen.getByTestId('manager-off');
    expect(hint.textContent).toBe('Luady is off. Turn it on in Settings.');
    expect(within(hint).getByRole('link', { name: 'Turn it on in Settings' }).getAttribute('href')).toBe('/settings');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/offline|down/i)).toBeNull();
    const input = screen.getByRole('textbox', { name: 'Message to Luady' }) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('Luady is off');
    expect((screen.getByRole('button', { name: 'Send to Luady' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'More ways to send' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(toggle(/^Show the conversation/));
    expect(screen.getByRole('log', { name: 'Messages with Luady' })).toBeTruthy();
    expect(api.sendToLuady).not.toHaveBeenCalled();
    act(() => ws.emit({ type: 'manager.status', status: luadyStatus({ state: 'running' }) }));
    expect(screen.queryByTestId('manager-off')).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Message to Luady' }) as HTMLInputElement).disabled).toBe(false);
  });
});

describe('cardFromText', () => {
  it('makes the first line the title and keeps the rest as details', () => {
    expect(cardFromText('Buy milk')).toEqual({ title: 'Buy milk', source: 'web' });
    expect(cardFromText('Fix login\nIt fails on Safari')).toEqual({ title: 'Fix login', details: 'Fix login\nIt fails on Safari', source: 'web' });
  });
});

function cardStub() {
  return {
    id: 1, title: 'Buy milk', details: '', project: null, server: null, source: 'web' as const, sourceRef: null, state: 'open' as const,
    today: false, priority: 0 as const, auto: false, runId: null, sessionId: null, result: null, createdAt: '', updatedAt: '', doneAt: null,
    dueAt: null, snoozeUntil: null,
  };
}

describe('HoverTip', () => {
  it('shows name, state in words and project while hovering an agent, and hides otherwise', () => {
    const feed = createFeed<StageEvent>();
    render(<HoverTip snapshot={snapshotOf()} feed={feed} />);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => feed.emit({ type: 'hover', id: 'ash:harbor-web', fixture: null, x: 120, y: 80 }));
    expect(screen.getByRole('tooltip').textContent).toBe('harbor-web · waiting for you · harbor-web');
    act(() => feed.emit({ type: 'hover', id: LUADY_ACTOR_ID, fixture: null, x: 10, y: 10 }));
    expect(screen.getByRole('tooltip').textContent).toBe('Luady · ready');
    act(() => feed.emit({ type: 'hover', id: null, fixture: null, x: 0, y: 0 }));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
