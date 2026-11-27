import { CtlGitStatusSchema, CtlKbPutSchema, CtlSkillsSchema, type HostId } from '@luady/shared';
import { PREVIEW_SERVERS } from '../config.ts';
import { describe, expect, it } from 'vitest';
import { createFakeKit, KIT_VERSION } from '../fake-kit.ts';
import { createKbFolder } from '../fake-kit-v21.ts';

const NOW = new Date('2026-11-15T08:00:00.000Z');
const SYSINFO = { load1: 0.1, load5: 0.2, mem_total_kb: 8_000_000, mem_avail_kb: 4_000_000, disk_free_kb: 9_000_000, uptime_s: 900_000 };
const kitFor = (host: HostId) => createFakeKit(host, { clock: () => NOW, sysinfo: SYSINFO });

describe('kit 2.1 verbs in the fake kit', () => {
  it('reports kit 2.1.0, so the hub copies the knowledge base and lists skills', async () => {
    expect(KIT_VERSION.kit).toBe('2.1.0');
    expect((await kitFor('birch').client.version()).kit).toBe('2.1.0');
  });

  it('lists a believable, valid skill list per server, grouped by source', async () => {
    for (const host of PREVIEW_SERVERS) {
      const answer = CtlSkillsSchema.parse(await kitFor(host).client.skills());
      expect(answer.skills.length).toBeGreaterThan(3);
      expect(new Set(answer.skills.map((s) => s.source))).toEqual(new Set(['user', 'project', 'plugin']));
      expect(new Set(answer.skills.map((s) => s.name)).size).toBe(answer.skills.length);
    }
    expect((await kitFor('birch').client.skills()).skills.map((s) => s.name)).toContain('jira-ticket');
  });

  it('kb-put keeps what it was sent, prunes what is gone, and a test can read it back', async () => {
    const kit = kitFor('cedar');
    const first = await kit.client.kbPut([{ path: 'INDEX.md', content: '# Index' }, { path: 'global/how-we-work.md', content: 'rules' }], true);
    expect(CtlKbPutSchema.parse(first)).toEqual({ written: 2, removed: 0 });
    const second = await kit.client.kbPut([{ path: 'INDEX.md', content: '# Index 2' }], true);
    expect(second).toEqual({ written: 1, removed: 1 });
    expect([...kit.kbFiles()]).toEqual([['INDEX.md', '# Index 2']]);
    await kit.client.kbPut([{ path: 'global/extra.md', content: 'x' }], false);
    expect([...kit.kbFiles().keys()].sort()).toEqual(['INDEX.md', 'global/extra.md']);
  });

  it('kb-put refuses paths outside the folder, like the kit', () => {
    const folder = createKbFolder();
    for (const path of ['../escape.md', '/etc/passwd.md', 'global/.hidden.md', 'notes.txt']) {
      expect(() => folder.put([{ path, content: 'x' }], true)).toThrow(/kb-put refused/);
    }
    expect(folder.files().size).toBe(0);
  });

  it('git-status answers one valid entry per project folder', async () => {
    const kit = kitFor('birch');
    kit.addPane('app-backend', '/home/dev/projects/app-backend');
    kit.addPane('menu-import', '/home/dev/projects/menu-import');
    const status = CtlGitStatusSchema.parse(await kit.client.gitStatus());
    expect(status.projects.map((p) => p.name)).toEqual(['app-backend', 'menu-import']);
    expect(status.projects[0]).toMatchObject({ dirty: true, ahead: 2 });
  });
});
