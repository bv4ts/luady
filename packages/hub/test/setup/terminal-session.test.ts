import { describe, expect, it, vi } from 'vitest';
import { resetPin } from '../../src/setup/index.js';
import { createSessionStore } from '../../src/web/auth/sessions.js';
import { createFakeShell, fakeFleet, fakeTickets, harnessFactory } from '../web/helpers.js';
import { connectWs, listen, sleep, wsHeaders } from '../web/ws-helpers.js';

const harness = harnessFactory();
const TICKET = 'c'.repeat(64);
const CHECK_MS = 40;

async function openTerminal() {
  const shell = createFakeShell();
  const fleet = fakeFleet(shell);
  const h = await harness({ fleet, tickets: fakeTickets({ [TICKET]: { server: 'birch' } }) }, { wsSessionCheckMs: CHECK_MS });
  const base = await listen(h);
  const session = h.login();
  const probe = await connectWs(`${base}/ws/terminal?ticket=${TICKET}`, wsHeaders(h, session));
  await vi.waitFor(() => expect(shell.onData).toHaveBeenCalled());
  return { h, shell, session, probe };
}

describe('an open web terminal ends with the session that opened it', () => {
  it('stays open while its session lives', async () => {
    const { probe, shell } = await openTerminal();
    await sleep(CHECK_MS * 4);
    expect(probe.ws.readyState).toBe(probe.ws.OPEN);
    expect(shell.close).not.toHaveBeenCalled();
    probe.ws.close();
  });

  it('signing out closes it (4401) and closes the shell', async () => {
    const { h, session, probe, shell } = await openTerminal();
    createSessionStore({ db: h.deps.db, clock: h.clock }).destroy(session.sid);
    expect((await probe.closed).code).toBe(4401);
    await vi.waitFor(() => expect(shell.close).toHaveBeenCalled());
  });

  it('ends the terminal, and throws nothing, when the check itself fails because the hub is stopping', async () => {
    const { h, probe, shell } = await openTerminal();
    // The database closes first when the hub stops; the timer must treat that as "the session has ended".
    h.deps.db.close();
    expect((await probe.closed).code).toBe(4401);
    await vi.waitFor(() => expect(shell.close).toHaveBeenCalled());
  });

  it('luady pin reset closes it: the reset ends every session', async () => {
    const { h, probe, shell } = await openTerminal();
    resetPin(h.deps.db);
    expect((await probe.closed).code).toBe(4401);
    await vi.waitFor(() => expect(shell.close).toHaveBeenCalled());
  });
});
