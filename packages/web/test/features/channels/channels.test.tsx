import type { ChannelInfoDTO } from '@luady/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelsApi } from '../../../src/api/channels.js';
import { ChannelsSection } from '../../../src/features/channels/ChannelsSection.js';
import { ConnectServices } from '../../../src/features/channels/ConnectServices.js';
import { NOTICE_FILE_MEMORY_MAX_BYTES, NoticeFile, fileSize } from '../../../src/features/channels/NoticeFile.js';
import { primaryChannel, withChannel } from '../../../src/features/channels/useChannels.js';
import { channelWarning } from '../../../src/layout/StatusBanners.js';
import { fakeApi } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';

const CAPS = {
  text: true, files: false, edit: false, pin: false, revoke: false, typing: false, played: false, profile: false,
  replyQuote: false, voiceNotes: false, maxText: 4000, maxFileBytes: 0,
};

function channel(over: Partial<ChannelInfoDTO> = {}): ChannelInfoDTO {
  return {
    id: 'test-channel', kind: 'channel', name: 'Test chat', state: 'up', detail: null, since: '2026-11-21T08:00:00.000Z',
    primary: true, capabilities: CAPS, panel: null, ...over,
  };
}

function fakeChannelsApi(list: ChannelInfoDTO[]): ChannelsApi & { [K in keyof ChannelsApi]: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => list),
    action: vi.fn(async () => undefined),
    connect: vi.fn(async () => ({ url: 'https://accounts.example.com/consent?state=s1' })),
    download: vi.fn(async () => new Blob(['%PDF'])),
  } as unknown as ChannelsApi & { [K in keyof ChannelsApi]: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  // jsdom has no 2D canvas: a stand-in that accepts the QR drawer's calls.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect: vi.fn(), fillStyle: '' } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ChannelsSection', () => {
  it('with no channel it says so calmly and points to the add-on guide; no error', async () => {
    await renderPage(<ChannelsSection api={fakeChannelsApi([])} />);
    expect(await screen.findByText('No chat channel is connected. Updates, questions and files reach you here on the website.')).toBeTruthy();
    expect(screen.getByText('packages/addon-sdk/README.md')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('.form-error')).toBeNull();
  });

  it('the compact form (the wizard) keeps only the first line', async () => {
    await renderPage(<ChannelsSection compact api={fakeChannelsApi([])} />);
    expect(await screen.findByTestId('channels-none')).toBeTruthy();
    expect(screen.queryByText('packages/addon-sdk/README.md')).toBeNull();
  });

  it('renders an add-on panel as text only: markup stays text, a QR is a drawn canvas, a code is plain', async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const api = fakeChannelsApi([channel({
      state: 'linking', detail: '<b>bold?</b>',
      panel: { title: 'Link', blocks: [{ type: 'text', text: hostile }, { type: 'qr', data: '2@abc,def' }, { type: 'code', text: 'ABCD-1234' }] },
    })]);
    const { container } = await renderPage(<ChannelsSection api={api} />);
    expect(await screen.findByText(hostile)).toBeTruthy();
    expect(screen.getByText('<b>bold?</b>')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByRole('img', { name: 'Test chat link code' }).tagName).toBe('CANVAS');
    expect(screen.getByText('ABCD-1234').tagName).toBe('CODE');
    expect(screen.getByText('Needs linking')).toBeTruthy();
  });

  it('a button sends its action; a PIN button asks for the PIN first and sends it', async () => {
    const api = fakeChannelsApi([channel({
      panel: { title: 'Link', blocks: [
        { type: 'button', label: 'Ping', action: 'ping' },
        { type: 'button', label: 'Unlink', action: 'unlink', pin: true, danger: true },
      ] },
    })]);
    const { user } = await renderPage(<ChannelsSection api={api} />);
    await user.click(await screen.findByRole('button', { name: 'Ping' }));
    await waitFor(() => expect(api.action).toHaveBeenCalledWith('test-channel', { action: 'ping', value: null }));
    await user.click(screen.getByRole('button', { name: 'Unlink' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unlink' });
    expect(api.action).toHaveBeenCalledTimes(1);
    await user.type(within(dialog).getByLabelText('PIN'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.action).toHaveBeenLastCalledWith('test-channel', { action: 'unlink', value: null, pin: '123456' }));
  });

  it('an input sends its text with its action', async () => {
    const api = fakeChannelsApi([channel({ panel: { title: 'Link', blocks: [{ type: 'input', id: 'answer', label: 'Paste the answer', action: 'answer' }] } })]);
    const { user } = await renderPage(<ChannelsSection api={api} />);
    await user.type(await screen.findByLabelText('Paste the answer'), 'the-answer');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.action).toHaveBeenCalledWith('test-channel', { action: 'answer', value: 'the-answer' }));
  });

  it('without an api of its own it reads the channels from the page client (api.channels), like every other route', async () => {
    const api = fakeApi({ channels: { list: async () => [channel({ state: 'up' })] } });
    await renderPage(<ChannelsSection />, { api });
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(api.channels.list).toHaveBeenCalledTimes(1);
  });

  it('follows channel.status live', async () => {
    const { ws } = await renderPage(<ChannelsSection api={fakeChannelsApi([channel({ state: 'up' })])} />);
    expect(await screen.findByText('Connected')).toBeTruthy();
    act(() => ws.emit({ type: 'channel.status', channel: channel({ state: 'down', detail: 'No network' }) }));
    expect(await screen.findByText('Down')).toBeTruthy();
    expect(screen.getByText('No network')).toBeTruthy();
  });
});

describe('the banner and the helpers', () => {
  it('warns only about a declared primary channel that is not up', () => {
    expect(channelWarning(null)).toBeNull();
    expect(channelWarning(channel({ state: 'up' }))).toBeNull();
    expect(channelWarning(channel({ state: 'starting' }))).toBeNull();
    expect(channelWarning(channel({ state: 'down' }))).toBe('Test chat is not connected, so updates reach only this website.');
    expect(channelWarning(channel({ state: 'linking' }))).toMatch(/needs linking again/);
    expect(primaryChannel([channel({ primary: false })])).toBeNull();
    expect(withChannel(null, channel()).map((c) => c.id)).toEqual(['test-channel']);
    expect(withChannel([channel({ state: 'up' })], channel({ state: 'down' })).map((c) => c.state)).toEqual(['down']);
  });
});

describe('connecting accounts and the file download', () => {
  it('Connect asks for the PIN, then goes to the provider link', async () => {
    const api = fakeChannelsApi([]);
    const go = vi.fn();
    const { user } = await renderPage(<ConnectServices api={api} go={go} />);
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[2] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Connect Wispr Flow' });
    await user.type(within(dialog).getByLabelText('PIN'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(go).toHaveBeenCalledWith('https://accounts.example.com/consent?state=s1'));
    expect(api.connect).toHaveBeenCalledWith('wispr', { pin: '123456' });
  });

  it('without an api of its own Connect goes through the page client (api.channels)', async () => {
    const api = fakeApi({ channels: { connect: async () => ({ url: 'https://accounts.example.com/consent?state=s2' }) } });
    const go = vi.fn();
    const { user } = await renderPage(<ConnectServices go={go} />, { api });
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Connect Google (personal)' });
    await user.type(within(dialog).getByLabelText('PIN'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(go).toHaveBeenCalledWith('https://accounts.example.com/consent?state=s2'));
    expect(api.channels.connect).toHaveBeenCalledWith('google', { pin: '123456', label: 'personal' });
  });

  it('a notice file downloads through the API (with the page key), never as a plain link', async () => {
    const api = fakeChannelsApi([]);
    const created = vi.fn(() => 'blob:hub/1');
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const file = { id: '00000000-0000-4000-8000-000000000001', name: 'report.pdf', mime: 'application/pdf', size: 2048 };
    await renderPage(<NoticeFile file={file} api={api} />);
    const button = screen.getByRole('button', { name: 'report.pdf (2 KB)' });
    expect(document.querySelector('a[href*="/api/files"]')).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(api.download).toHaveBeenCalledWith(file));
    expect(created).toHaveBeenCalled();
    // Whatever type the hub sent, the page hands the browser plain bytes to save.
    expect((created.mock.calls[0] as unknown as [Blob])[0].type).toBe('application/octet-stream');
    expect(fileSize(3 * 1_048_576)).toBe('3.0 MB');
  });

  it('a file over the memory cap is not fetched; the page says so plainly', async () => {
    const api = fakeChannelsApi([]);
    const file = { id: '00000000-0000-4000-8000-000000000002', name: 'movie.mp4', mime: 'video/mp4', size: NOTICE_FILE_MEMORY_MAX_BYTES + 1 };
    await renderPage(<NoticeFile file={file} api={api} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText((text) => text.startsWith('movie.mp4 (100.0 MB) is too big to save from this page'))).toBeTruthy();
    expect(api.download).not.toHaveBeenCalled();
  });
});
