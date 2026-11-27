import type { AccountDTO } from '@luady/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startFakeServer, type FakeServer } from '../harness/docker.js';
import { startTestHub, type TestHub } from '../harness/hub.js';
import { syncStream, typeInto, waitForLog, waitForSession } from '../harness/scenario.js';
import { waitFor } from '../harness/wait.js';

const TARGET = 'cc-alpha:0.0';
const ID = `cedar:${TARGET}`;

/** The Claude account that groups host cedar (the fake signs in as org_fake / "Fake Team"). */
async function cedarAccount(hub: TestHub): Promise<AccountDTO | undefined> {
  const { accounts } = await hub.app.services.accounts.list();
  return accounts.find((a) => a.provider === 'claude' && a.hosts.some((h) => h.host === 'cedar'));
}

describe('accounts: a server that reports its organisation and limits', () => {
  let server: FakeServer;
  let hub: TestHub;
  let sid = '';

  beforeAll(async () => {
    server = await startFakeServer(inject('luadyIt'));
    hub = await startTestHub({ env: inject('luadyIt'), server });
    await syncStream(hub, server);
    await server.startClaude('alpha', '/home/dev/projects/alpha');
    sid = String((await waitForLog(server, (e) => e.kind === 'start' && e.target === TARGET, 'fake-claude start')).sid);
    await waitForSession(hub, ID, (s) => s.state === 'idle', 'alpha idle');
  });

  afterAll(async () => {
    await hub?.stop();
    await server?.down();
  });

  it('lists cedar under its organisation and reports its limits once a status line arrives', async () => {
    await hub.app.services.login.refresh('cedar');
    const account = await cedarAccount(hub);
    expect(account).toBeDefined();
    expect(account?.orgName).toBe('Fake Team');
    expect(account?.plan).toBe('team');

    // The session's first status line (at startup, before this turn) already forwarded a reading with both windows.
    await typeInto(server, TARGET, 'a turn that prints a status line');
    await waitForLog(server, (e) => e.kind === 'received' && e.sid === sid && e.text === 'a turn that prints a status line', 'the turn');
    await waitForSession(hub, ID, (s) => s.state === 'idle', 'idle after the turn');
    const reported = await waitFor(async () => {
      const a = await cedarAccount(hub);
      return a?.limits.reported === 'yes' ? a : undefined;
    }, { timeoutMs: 60_000, what: "cedar's limits reported as known" });
    expect(reported.limits.sevenDay).not.toBeNull();
  });

  it('signs cedar out through the fleet client, and the next status agrees', async () => {
    const out = await hub.app.services.fleet.client('cedar').authLogout();
    expect(out.logged_in).toBe(false);
    const status = await hub.app.services.fleet.client('cedar').authStatus();
    expect(status.logged_in).toBe(false);
  });
});

describe('accounts: a plan that does not report limits', () => {
  let server: FakeServer;
  let hub: TestHub;
  let sid = '';

  beforeAll(async () => {
    server = await startFakeServer(inject('luadyIt'));
    hub = await startTestHub({ env: inject('luadyIt'), server });
    await syncStream(hub, server);
    // The fake omits rate_limits from every status line while this file exists (set before the first one runs).
    await server.execOk('dev', 'mkdir -p "$HOME/.fake-claude" && : > "$HOME/.fake-claude/no-limits"');
    await server.startClaude('alpha', '/home/dev/projects/alpha');
    sid = String((await waitForLog(server, (e) => e.kind === 'start' && e.target === TARGET, 'fake-claude start')).sid);
    await waitForSession(hub, ID, (s) => s.state === 'idle', 'alpha idle');
  });

  afterAll(async () => {
    await hub?.stop();
    await server?.down();
  });

  it('settles to "does not report limits" after five empty readings', async () => {
    await hub.app.services.login.refresh('cedar');
    for (let turn = 1; turn <= 5; turn += 1) {
      // Change a meter each turn so the status line forwards again (it forwards only on a signature change); with
      // the no-limits file both windows stay absent, so each forward is one "empty" reading.
      await server.execOk('dev', `printf '%s' '{"context":${turn * 10}}' > "$HOME/.fake-claude/status.json"`);
      const text = `empty-reading turn ${turn}`;
      await typeInto(server, TARGET, text);
      await waitForLog(server, (e) => e.kind === 'received' && e.sid === sid && e.text === text, text);
      await waitForSession(hub, ID, (s) => s.state === 'idle', `idle after turn ${turn}`);
    }
    const account = await waitFor(async () => {
      const a = await cedarAccount(hub);
      return a?.limits.reported === 'no' ? a : undefined;
    }, { timeoutMs: 60_000, what: "cedar's plan reported as not reporting limits" });
    expect(account.limits.fiveHour).toBeNull();
    expect(account.limits.sevenDay).toBeNull();
  });
});
