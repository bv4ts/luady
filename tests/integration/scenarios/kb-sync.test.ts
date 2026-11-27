import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startFakeServer, type FakeServer } from '../harness/docker.js';
import { startTestHub, type TestHub } from '../harness/hub.js';
import { syncStream } from '../harness/scenario.js';
import { waitFor } from '../harness/wait.js';

/**
 * The knowledge-base copy against a real kit 2.1: the pages that apply to cedar reach ~/luady-kb/ with
 * an INDEX.md, a removed page is pruned on the next copy, pages of other offices never arrive, and the kit's
 * SessionStart hook names the folder (and the project's pages) for a new session.
 */

let server: FakeServer;
let hub: TestHub;

beforeAll(async () => {
  server = await startFakeServer(inject('luadyIt'));
  hub = await startTestHub({ env: inject('luadyIt'), server });
  await syncStream(hub, server);
  await waitFor(() => (hub.app.services.fleet.servers().find((s) => s.name === 'cedar')?.kitVersion === '2.1.0' ? true : undefined), {
    timeoutMs: 60_000, what: 'cedar reports kit 2.1.0',
  });
});

afterAll(async () => {
  await hub?.stop();
  await server?.down();
});

async function kbFiles(): Promise<string[]> {
  const out = await server.execOk('dev', 'cd "$HOME/luady-kb" 2>/dev/null && find . -type f -name "*.md" | sort || true');
  return out.split('\n').map((line) => line.trim().replace(/^\.\//, '')).filter(Boolean);
}

const read = (path: string): Promise<string> => server.execOk('dev', `cat "$HOME/luady-kb/${path}"`);

describe('knowledge base copy to a server', () => {
  it('copies the pages that apply to cedar, prunes a removed one, and the next session is told about the folder', async () => {
    const kb = hub.app.services.kb;
    const rules = await kb.create({ scope: 'global', title: 'How we work', body: 'Run the tests before every push.' }, 'owner');
    const alpha = await kb.create({ scope: 'project', server: 'cedar', project: 'alpha', title: 'Alpha deploys', body: 'Deploy with make ship.' }, 'owner');
    const office = await kb.create({ scope: 'office', server: 'cedar', title: 'Meadow servers', body: 'Backups at 2 AM.' }, 'manager');
    await kb.create({ scope: 'office', server: 'birch', title: 'Orchard only', body: 'Never on cedar.' }, 'owner');

    await kb.sync('cedar');
    const first = await kbFiles();
    expect(first).toEqual(expect.arrayContaining(['INDEX.md', `global/${rules.slug}.md`, `office/${office.slug}.md`, `alpha/${alpha.slug}.md`]));
    expect(first.some((path) => path.includes('orchard-only'))).toBe(false);
    expect(await read(`alpha/${alpha.slug}.md`)).toContain('Deploy with make ship.');
    const index = await read('INDEX.md');
    expect(index).toContain('How we work');
    expect(index).not.toContain('Orchard only');
    expect(hub.app.services.kb.list({}).syncedAt.cedar).toEqual(expect.any(String));

    await kb.remove(office.id);
    await kb.sync('cedar');
    const second = await kbFiles();
    expect(second).not.toContain(`office/${office.slug}.md`);
    expect(second).toContain(`alpha/${alpha.slug}.md`);
    expect(await read('INDEX.md')).not.toContain('Meadow servers');

    // The kit's SessionStart hook, as Claude Code runs it for a new session in alpha (outside tmux: no pane to map).
    const payload = JSON.stringify({
      session_id: '00000000-0000-4000-8000-0000000000b1', transcript_path: '/dev/null', cwd: '/home/dev/projects/alpha',
      hook_event_name: 'SessionStart', source: 'startup', model: 'opus',
    });
    const out = await server.execOk('dev', 'python3 "$HOME/.luady/hooks/luady_hook.py"', payload);
    const context = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(context).toContain('/home/dev/luady-kb/');
    expect(context).toContain('INDEX.md');
    expect(context).toContain('/home/dev/luady-kb/alpha/');
  });
});
