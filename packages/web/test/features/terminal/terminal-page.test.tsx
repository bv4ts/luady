import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/api/errors.js';
import { TerminalPage } from '../../../src/features/terminal/TerminalPage.js';
import { fakeApi } from '../../helpers/fake-api.js';
import { FakeSocket } from '../../helpers/fake-socket.js';
import { overview, server } from '../../fixtures.js';
import { renderPage } from '../../helpers/render.js';

/** The hub's servers: cedar, birch and ash, each with a web terminal. */
const FLEET = overview({ servers: [server(), server({ name: 'birch' }), server({ name: 'ash' })] });

const xterm = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    readonly options: unknown;
    cols = 120;
    rows = 40;
    written: string[] = [];
    disposed = false;
    private dataListener: ((data: string) => void) | null = null;

    constructor(options: unknown) {
      this.options = options;
      FakeTerminal.instances.push(this);
    }

    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    dispose(): void {
      this.disposed = true;
    }
    write(data: string): void {
      this.written.push(data);
    }
    onData(listener: (data: string) => void) {
      this.dataListener = listener;
      return { dispose: () => { this.dataListener = null; } };
    }
    onResize() {
      return { dispose: () => undefined };
    }
    type(data: string): void {
      this.dataListener?.(data);
    }
  }
  return { FakeTerminal };
});

vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} activate(): void {} dispose(): void {} } }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {
      return { dispose: () => undefined };
    }
    activate(): void {}
    dispose(): void {}
  },
}));

const TICKET = 'T'.repeat(64);

beforeEach(() => {
  FakeSocket.reset();
  xterm.FakeTerminal.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

describe('TerminalPage', () => {
  it('asks for the PIN, opens a ticket and bridges the terminal', async () => {
    const api = fakeApi({ openTerminal: async () => ({ ticket: TICKET }) });
    const { user } = await renderPage(<TerminalPage />, { api, route: '/terminal/cedar?target=cc-meadow-hr%3A0.0', path: '/terminal/:server' });
    const dialog = await screen.findByRole('dialog', { name: 'Open terminal on cedar' });
    await user.type(within(dialog).getByLabelText('PIN'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    expect(api.openTerminal).toHaveBeenCalledWith({ server: 'cedar', target: 'cc-meadow-hr:0.0', pin: '123456' });
    const socket = FakeSocket.last();
    expect(socket.url).toMatch(/^ws:\/\/[^/]+\/ws\/terminal\?ticket=T{64}$/);
    act(() => socket.open());
    expect(socket.sentJson()).toEqual([{ type: 'resize', cols: 120, rows: 40 }]);
    expect(screen.getByText('Connected')).toBeTruthy();
    act(() => socket.receive({ type: 'output', data: 'dev@cedar:~$ ' }));
    expect(xterm.FakeTerminal.instances[0]?.written).toEqual(['dev@cedar:~$ ']);
    await user.click(screen.getByRole('button', { name: 'Control C' }));
    expect(socket.sentJson().at(-1)).toEqual({ type: 'input', data: '\u0003' });
    act(() => socket.receive({ type: 'exit', code: 0 }));
    expect(screen.getByText('The shell exited with code 0.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  });

  it('explains an idle-timeout close (4408)', async () => {
    const api = fakeApi({ openTerminal: async () => ({ ticket: TICKET }) });
    const { user } = await renderPage(<TerminalPage />, { api, route: '/terminal/birch', path: '/terminal/:server', overview: FLEET });
    const dialog = await screen.findByRole('dialog', { name: 'Open terminal on birch' });
    await user.type(within(dialog).getByLabelText('PIN'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    act(() => FakeSocket.last().open());
    act(() => FakeSocket.last().drop(4408));
    expect(screen.getByText('The terminal closed after 15 minutes without input.')).toBeTruthy();
  });

  it('goes back when the PIN prompt is cancelled', async () => {
    const api = fakeApi({ openTerminal: async () => ({ ticket: TICKET }) });
    const { user } = await renderPage(<TerminalPage />, { api, route: ['/servers/cedar', '/terminal/cedar'], path: '/terminal/:server' });
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/servers/cedar'));
    expect(api.openTerminal).not.toHaveBeenCalled();
  });

  it('rejects links to unknown servers', async () => {
    await renderPage(<TerminalPage />, { api: fakeApi(), route: '/terminal/vps', path: '/terminal/:server' });
    expect(screen.getByText('This terminal link is not valid.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says plainly that this computer has no terminal, and asks for no PIN', async () => {
    const api = fakeApi({ openTerminal: async () => ({ ticket: TICKET }) });
    await renderPage(<TerminalPage />, {
      api, route: '/terminal/computer', path: '/terminal/:server', overview: overview({ servers: [server({ name: 'computer', kind: 'local', terminal: false })] }),
    });
    expect(await screen.findByText('Terminal is not available for this computer.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(api.openTerminal).not.toHaveBeenCalled();
  });

  it('opens a terminal on any host the hub lists, not only the classic ones', async () => {
    const api = fakeApi({ openTerminal: async () => ({ ticket: TICKET }) });
    await renderPage(<TerminalPage />, {
      api, route: '/terminal/mars', path: '/terminal/:server', overview: overview({ servers: [server({ name: 'mars' })] }),
    });
    expect(await screen.findByRole('dialog', { name: 'Open terminal on mars' })).toBeTruthy();
  });

  it('shows the hub error when the terminal cannot open', async () => {
    const api = fakeApi({ openTerminal: async () => { throw new ApiError(502, 'failed', 'ssh: connection refused'); } });
    const { user } = await renderPage(<TerminalPage />, { api, route: '/terminal/ash', path: '/terminal/:server', overview: FLEET });
    const dialog = await screen.findByRole('dialog', { name: 'Open terminal on ash' });
    await user.type(within(dialog).getByLabelText('PIN'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('The server command failed: ssh: connection refused')).toBeTruthy();
    expect(FakeSocket.instances).toHaveLength(0);
  });
});
