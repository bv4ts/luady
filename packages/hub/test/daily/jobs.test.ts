import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Db, LuadyService } from '../../src/core/contracts.js';
import { createDailyJobs } from '../../src/daily/jobs.js';
import { MIGRATIONS, migrate } from '../../src/db/migrate.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createSettingsService } from '../../src/settings/service.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';

/** One owner day in the test zone (Etc/GMT-4): every job's time and window fall inside it. */
const TIMES: Readonly<Record<string, string>> = {
  graphify: '2026-11-20T22:00:30Z', // 02:00
  digest: '2026-11-20T23:30:30Z', // 03:30
  rotate: '2026-11-21T00:00:30Z', // 04:00
  tools: '2026-11-21T01:00:30Z', // 05:00
  claude: '2026-11-21T00:30:30Z', // 04:30 (CLAUDE_UPDATE_TIME)
  brief: '2026-11-21T04:00:30Z', // 08:00
};

function rig(settings: Partial<Settings>, opts: { db?: Db; managerReady?: () => boolean } = {}) {
  const db = opts.db ?? openMemoryDb();
  db.prepare("INSERT INTO messages (id, thread, role, channel, text, ts) VALUES ('m1', 'manager', 'owner', 'web', 'hello', '2026-11-20T09:00:00Z')").run();
  const clock = createFakeClock(TIMES.graphify);
  const ran: string[] = [];
  const luady = {
    postEvent: vi.fn(async (text: string) => {
      ran.push(text.startsWith('Morning brief') ? 'brief' : 'digest');
    }),
    rotate: vi.fn(async () => {
      ran.push('rotate');
      return true;
    }),
  } as unknown as LuadyService;
  const jobs = createDailyJobs({
    db, clock, log: silentLogger(), settings: { get: () => ({ ...DEFAULT_SETTINGS, ...settings }), update: vi.fn() }, luady,
    brainDir: mkdtempSync(join(tmpdir(), 'luady-jobs-')),
    graphify: async () => ran.push('graphify'),
    updateTools: async () => ran.push('tools'),
    claudeUpdate: async () => {
      ran.push('claude');
      return true;
    },
    briefData: async () => '## To-do\n- none',
    ...(opts.managerReady === undefined ? {} : { managerReady: opts.managerReady }),
  });
  const night = async (): Promise<string[]> => {
    for (const at of ['graphify', 'digest', 'rotate', 'claude', 'tools', 'brief']) {
      clock.set(TIMES[at] ?? '');
      await jobs.tick();
    }
    return [...ran].sort();
  };
  return { night };
}

const ALL_ON: Partial<Settings> = {
  manager_enabled: true, digest_enabled: true, brief_enabled: true, claude_update_enabled: true, tools_update_enabled: true, graphify_enabled: true,
};

describe('the nightly switches', () => {
  it('off by default: a new install runs none of the five nightly jobs, and no rotation without the manager', async () => {
    expect(await rig({}, { managerReady: () => false }).night()).toEqual([]);
  });

  it('each switch runs exactly its own job', async () => {
    const cases: ReadonlyArray<readonly [Partial<Settings>, string]> = [
      [{ digest_enabled: true }, 'digest'],
      [{ brief_enabled: true }, 'brief'],
      [{ claude_update_enabled: true }, 'claude'],
      [{ tools_update_enabled: true }, 'tools'],
      [{ graphify_enabled: true }, 'graphify'],
    ];
    for (const [switches, job] of cases) {
      expect(await rig(switches, { managerReady: () => false }).night(), job).toEqual(
        job === 'digest' || job === 'brief' ? [] : [job],
      );
      expect((await rig(switches, { managerReady: () => true }).night()).filter((name) => name !== 'rotate'), job).toEqual([job]);
    }
  });

  it('the Claude Code update, the tools update and the code map run whether or not the manager is on', async () => {
    const off = await rig({ claude_update_enabled: true, tools_update_enabled: true, graphify_enabled: true }, { managerReady: () => false }).night();
    expect(off).toEqual(['claude', 'graphify', 'tools']);
  });

  it('the digest, the brief and the rotation need the manager', async () => {
    expect(await rig({ digest_enabled: true, brief_enabled: true }, { managerReady: () => false }).night()).toEqual([]);
    expect(await rig({ digest_enabled: true, brief_enabled: true }, { managerReady: () => true }).night()).toEqual(['brief', 'digest', 'rotate']);
  });

  it('all on after 016 on an existing install (one with a passkey); all off on a new one', async () => {
    const existing = new Database(':memory:');
    existing.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const migration of MIGRATIONS.filter((m) => m.version <= 15)) {
      existing.exec(migration.sql);
      existing.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, TIMES.graphify);
    }
    existing.prepare("INSERT INTO auth_passkeys (cred_id, public_key, counter, transports_json, label, created_at) VALUES ('c', x'00', 0, '[]', 'Phone', ?)")
      .run(TIMES.graphify);
    migrate(existing);
    const stored = createSettingsService({ db: existing, bus: createBus() }).get();
    expect(stored).toMatchObject(ALL_ON);
    expect(await rig(stored, { managerReady: () => stored.manager_enabled }).night()).toEqual(['brief', 'claude', 'digest', 'graphify', 'rotate', 'tools']);
    const fresh = createSettingsService({ db: openMemoryDb(), bus: createBus() }).get();
    expect(fresh).toMatchObject({ manager_enabled: false, digest_enabled: false, brief_enabled: false, claude_update_enabled: false, tools_update_enabled: false, graphify_enabled: false });
  });
});
