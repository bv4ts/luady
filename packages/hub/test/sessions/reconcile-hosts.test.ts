import { describe, expect, it } from 'vitest';
import { SELF_HOST_ID, type HostId } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Fleet } from '../../src/core/contracts.js';
import { createClaudeLoginService } from '../../src/claude-login/service.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createSessionReconciler } from '../../src/sessions/reconcile.js';
import { createSessionsRepo } from '../../src/sessions/repo.js';
import { DEFAULT_SETTINGS } from '@luady/shared';
import { serverDto } from '../fleet/fake-fleet.js';
import { createFakeClock, createFakeCtl } from '../helpers/fakes.js';
import { createCaptureLogger } from '../security/capture-logger.js';

const NOW = '2026-11-21T08:00:00.000Z';

/** A fleet whose host list is the test's: the self host only while "the manager is switched on". */
function fleetWith(hosts: () => readonly HostId[], asked: HostId[]): Fleet {
  return {
    hosts: () => [...hosts()],
    servers: () => [serverDto('cedar'), serverDto('ash', 'offline')],
    client: (host: HostId) => {
      asked.push(host);
      return createFakeCtl();
    },
  } as unknown as Fleet;
}

describe('nothing asks the self host while the manager is off', () => {
  it('reconcile walks the fleet\'s hosts: the online servers, and the self host only while it is listed', async () => {
    let managerOn = false;
    const asked: HostId[] = [];
    const capture = createCaptureLogger();
    const reconciler = createSessionReconciler({
      repo: createSessionsRepo(openMemoryDb()), bus: createBus(), clock: createFakeClock(NOW), log: capture.log,
      fleet: fleetWith(() => ['cedar', 'ash', ...(managerOn ? [SELF_HOST_ID] : [])], asked),
    });
    await reconciler.runAll();
    expect(asked).toEqual(['cedar']);
    expect(capture.lines.filter((line) => line.includes('reconciliation failed'))).toEqual([]);
    managerOn = true;
    await reconciler.runAll();
    expect(asked).toEqual(['cedar', 'cedar', SELF_HOST_ID]);
  });

  it('the sign-in check walks the listed hosts: the self host only while it is listed', async () => {
    let managerOn = false;
    const asked: HostId[] = [];
    const fleet = fleetWith(() => [], asked);
    const login = createClaudeLoginService({
      db: openMemoryDb(), clock: createFakeClock(NOW), log: createCaptureLogger().log, bus: createBus(), fleet,
      outbound: { send: async () => null }, settings: { get: () => DEFAULT_SETTINGS }, luady: {},
      hosts: () => ['cedar', 'ash', ...(managerOn ? [SELF_HOST_ID] : [])],
    });
    await login.check();
    expect(asked).toEqual(['cedar']);
    expect(login.statuses().map((status) => status.host)).toEqual(['cedar', 'ash']);
    managerOn = true;
    await login.check();
    expect(asked).toEqual(['cedar', SELF_HOST_ID]);
  });
});
