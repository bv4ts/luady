import { describe, expect, it, vi } from 'vitest';
import { TermServerMessageSchema } from '@luady/shared';
import type { ShellStream } from '../../src/core/contracts.js';
import { createTicketStore } from '../../src/security/tickets.js';
import type { WebServerOptions } from '../../src/web/context.js';
import { createFakeClock } from '../helpers/fakes.js';
import { createFakeShell, fakeFleet, fakeTickets, harnessFactory } from './helpers.js';
import { connectWs, listen, rejectedStatus, sleep, wsHeaders } from './ws-helpers.js';

const harness = harnessFactory();
const TICKET = 'a'.repeat(64);

async function setup(options: Partial<WebServerOptions> = {}) {
  const shell = createFakeShell();
  const fleet = fakeFleet(shell);
  const tickets = fakeTickets({ [TICKET]: { server: 'birch', target: 'cc-orchard:0.0' } });
  const h = await harness({ fleet, tickets }, options);
  const base = await listen(h);
  const session = h.login();
  return { h, shell, fleet, tickets, base, url: `${base}/ws/terminal?ticket=${TICKET}`, headers: wsHeaders(h, session) };
}

describe('/ws/terminal', () => {
  it("opens a 120x32 shell on the ticket's server and tmux target", async () => {
    const { fleet, url, headers } = await setup();
    const probe = await connectWs(url, headers);
    await vi.waitFor(() =>
      expect(fleet.openShell).toHaveBeenCalledWith('birch', { cols: 120, rows: 32, tmuxTarget: 'cc-orchard:0.0' }),
    );
    probe.ws.close();
  });

  it('bridges output, input, resize and exit', async () => {
    const { shell, url, headers } = await setup();
    const probe = await connectWs(url, headers);
    await vi.waitFor(() => expect(shell.onData).toHaveBeenCalled());
    shell.emitData('hello\r\n');
    const output = await probe.next();
    expect(TermServerMessageSchema.parse(output)).toEqual({ type: 'output', data: 'hello\r\n' });
    probe.ws.send(JSON.stringify({ type: 'input', data: 'ls -la\r' }));
    await vi.waitFor(() => expect(shell.write).toHaveBeenCalledWith('ls -la\r'));
    probe.ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40 }));
    await vi.waitFor(() => expect(shell.resize).toHaveBeenCalledWith(100, 40));
    shell.emitExit(0);
    expect(await probe.next()).toEqual({ type: 'exit', code: 0 });
    expect((await probe.closed).code).toBe(1000);
  });

  it('a ticket is single use: the second connect closes with 4401', async () => {
    const { fleet, tickets, url, headers } = await setup();
    const first = await connectWs(url, headers);
    await vi.waitFor(() => expect(fleet.openShell).toHaveBeenCalledTimes(1));
    const second = await connectWs(url, headers);
    expect((await second.closed).code).toBe(4401);
    expect(tickets.consume).toHaveBeenCalledTimes(2);
    expect(fleet.openShell).toHaveBeenCalledTimes(1);
    first.ws.close();
  });

  it('opens the shell for the session the ticket was issued to', async () => {
    const shell = createFakeShell();
    const fleet = fakeFleet(shell);
    const tickets = createTicketStore(createFakeClock());
    const h = await harness({ fleet, tickets });
    const asker = h.login();
    const ticket = tickets.issue({ server: 'birch', sid: asker.sid });
    const base = await listen(h);
    const probe = await connectWs(`${base}/ws/terminal?ticket=${ticket}`, wsHeaders(h, asker));
    await vi.waitFor(() => expect(fleet.openShell).toHaveBeenCalledWith('birch', { cols: 120, rows: 32 }));
    probe.ws.close();
  });

  it('a ticket issued to another session closes with 4401 without opening a shell, and is spent', async () => {
    const shell = createFakeShell();
    const fleet = fakeFleet(shell);
    const tickets = createTicketStore(createFakeClock());
    const h = await harness({ fleet, tickets });
    const asker = h.login();
    const other = h.login();
    const ticket = tickets.issue({ server: 'birch', sid: asker.sid });
    const base = await listen(h);
    const url = `${base}/ws/terminal?ticket=${ticket}`;
    const stolen = await connectWs(url, wsHeaders(h, other));
    expect((await stolen.closed).code).toBe(4401);
    const late = await connectWs(url, wsHeaders(h, asker));
    expect((await late.closed).code).toBe(4401);
    expect(fleet.openShell).not.toHaveBeenCalled();
  });

  it('an unknown, malformed or missing ticket closes with 4401 without opening a shell', async () => {
    const { fleet, base, headers } = await setup();
    const urls = [`${base}/ws/terminal?ticket=${'b'.repeat(64)}`, `${base}/ws/terminal?ticket=bad%21ticket`, `${base}/ws/terminal`];
    for (const url of urls) {
      const probe = await connectWs(url, headers);
      expect((await probe.closed).code).toBe(4401);
    }
    expect(fleet.openShell).not.toHaveBeenCalled();
  });

  it('applies messages sent before the shell is ready', async () => {
    const { shell, fleet, url, headers } = await setup();
    let resolveShell: (value: ShellStream) => void = () => undefined;
    vi.mocked(fleet.openShell).mockImplementation(
      () =>
        new Promise<ShellStream>((resolve) => {
          resolveShell = resolve;
        }),
    );
    const probe = await connectWs(url, headers);
    probe.ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40 }));
    probe.ws.send(JSON.stringify({ type: 'input', data: 'pwd\r' }));
    await vi.waitFor(() => expect(fleet.openShell).toHaveBeenCalled());
    await sleep(50);
    resolveShell(shell);
    await vi.waitFor(() => expect(shell.resize).toHaveBeenCalledWith(100, 40));
    expect(shell.write).toHaveBeenCalledWith('pwd\r');
    probe.ws.close();
  });

  it('closes with 4408 after the idle timeout and closes the shell', async () => {
    const { shell, fleet, url, headers } = await setup({ terminalIdleMs: 150 });
    const probe = await connectWs(url, headers);
    await vi.waitFor(() => expect(fleet.openShell).toHaveBeenCalled());
    expect((await probe.closed).code).toBe(4408);
    await vi.waitFor(() => expect(shell.close).toHaveBeenCalled());
  });

  it('closes with 1008 on an invalid message and closes the shell', async () => {
    const { shell, url, headers } = await setup();
    const probe = await connectWs(url, headers);
    await vi.waitFor(() => expect(shell.onData).toHaveBeenCalled());
    probe.ws.send(JSON.stringify({ type: 'resize', cols: 1, rows: 1 }));
    expect((await probe.closed).code).toBe(1008);
    await vi.waitFor(() => expect(shell.close).toHaveBeenCalled());
  });

  it('sends exit and closes with 1011 when the shell cannot be opened', async () => {
    const { fleet, url, headers } = await setup();
    vi.mocked(fleet.openShell).mockRejectedValueOnce(new Error('ssh connection refused'));
    const probe = await connectWs(url, headers);
    expect(await probe.next()).toEqual({ type: 'exit', code: null });
    expect((await probe.closed).code).toBe(1011);
  });

  it('requires an app session before the upgrade (401) and never consumes the ticket', async () => {
    const { h, tickets, url } = await setup();
    expect(await rejectedStatus(url, wsHeaders(h))).toBe(401);
    expect(tickets.consume).not.toHaveBeenCalled();
  });
});
