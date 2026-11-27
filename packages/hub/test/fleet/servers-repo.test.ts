import { describe, expect, it } from 'vitest';
import { openMemoryDb } from '../../src/db/open.js';
import { createServersRepo } from '../../src/fleet/servers-repo.js';

const NOW = '2026-11-21T08:00:00.000Z';
const FP = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU';

describe('a host row whose state the hub does not know', () => {
  it('is read as a draft, never as pinned, so the fleet never reaches it', () => {
    const db = openMemoryDb();
    const repo = createServersRepo(db);
    repo.syncConfig(
      { servers: [{ name: 'cedar', host: 'cedar.example.com', user: 'dev', port: 22, hostKeyFp: FP }] },
      { user: 'dev', nowIso: NOW },
    );
    expect(repo.record('cedar')?.state).toBe('pinned');
    db.pragma('ignore_check_constraints = ON');
    db.prepare("UPDATE servers SET state = 'paused' WHERE name = 'cedar'").run();
    db.pragma('ignore_check_constraints = OFF');
    expect(repo.record('cedar')?.state).toBe('draft');
    expect(repo.pinned().map((host) => host.id)).not.toContain('cedar');
  });
});
