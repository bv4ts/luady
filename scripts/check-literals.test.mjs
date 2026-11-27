import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALLOW_FILE, IDS_FILE, checkRepository, checkText } from './check-literals.mjs';

const rules = (hits) => hits.map((hit) => hit.rule);

describe('check-literals: structural part', () => {
  it('fails a planted host comparison with a literal', () => {
    assert.deepEqual(rules(checkText('packages/hub/src/x.ts', "if (host === 'x') return;")), ['host-compare']);
    assert.deepEqual(rules(checkText('packages/hub/src/x.ts', 'if (session.host !== "mars") return;')), ['host-compare']);
    assert.deepEqual(rules(checkText('packages/web/src/x.ts', "const hint = server === 'cedar' ? a : b;")), ['host-compare']);
  });

  it('fails a fleet call with a literal host', () => {
    assert.deepEqual(rules(checkText('packages/hub/src/x.ts', "await fleet.client('ash').send(t, x);")), ['host-call']);
    assert.deepEqual(rules(checkText('packages/hub/src/x.ts', 'tailEvents("cedar", 0);')), ['host-call']);
    assert.deepEqual(rules(checkText('packages/hub/src/x.ts', "openShell('birch');")), ['host-call']);
  });

  it('passes comparisons that are not host ids, and calls with a variable', () => {
    const text = [
      "if (url.host === 'api.atlassian.com') x();",
      "if (host === '::1') y();",
      "if (form.server === '') z();",
      "if (typeof ResizeObserver === 'function') w();",
      'await fleet.client(host).send(t, x);',
      'if (isSelfHost(session.host)) return;',
    ].join('\n');
    assert.deepEqual(checkText('packages/web/src/x.ts', text), []);
  });

  it('allows ids.ts', () => {
    assert.deepEqual(checkText(IDS_FILE, "export function isSelfHost(host: string) { return host === 'hq'; }"), []);
  });
});

describe('check-literals: value part', () => {
  it('fails a planted .has of the self-host id in a file that is not on the allow-list', () => {
    assert.deepEqual(rules(checkText('packages/hub/src/x.ts', "if (names.has('hq')) return;")), ['self-host-literal']);
  });

  it('fails the id as an object key or a property', () => {
    assert.deepEqual(rules(checkText('preview/x.ts', 'const PHASE = { cedar: 0.4, hq: 5.2 };')), ['self-host-key']);
    assert.deepEqual(rules(checkText('packages/web/src/x.ts', 'const zone = map.zones.hq;')), ['self-host-property']);
  });

  it('allows the literal in an allow-listed file, and a spread of a variable named like it', () => {
    assert.deepEqual(checkText('packages/office/src/teams.ts', "hq: Object.freeze({ id: 'hq' }),", { allowed: true }), []);
    assert.deepEqual(checkText('packages/office/src/x.ts', 'return [...rooms, ...hq];'), []);
  });

  it('fails any SQL string that holds the quoted id, also in ids.ts and in allow-listed files', () => {
    const sql = 'const rows = db.prepare("SELECT id FROM sessions WHERE host = \'hq\'").all();';
    assert.deepEqual(rules(checkText('packages/hub/src/x.ts', sql)), ['self-host-literal', 'self-host-sql']);
    assert.deepEqual(rules(checkText('packages/office/src/teams.ts', sql, { allowed: true })), ['self-host-sql']);
    assert.deepEqual(rules(checkText(IDS_FILE, sql)), ['self-host-sql']);
    const multiLine = "const q = `\n  SELECT 1 FROM events e\n  WHERE e.host != 'hq'\n`;";
    assert.ok(rules(checkText('packages/office/src/teams.ts', multiLine, { allowed: true })).includes('self-host-sql'));
  });

  it('ignores lines that are only a comment', () => {
    assert.deepEqual(checkText('packages/hub/src/x.ts', "// the self host ('hq') is compared through isSelfHost\n# host == 'x'"), []);
  });
});

describe('check-literals: repository', () => {
  const dirs = [];
  after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  const repo = (files, allow) => {
    const root = mkdtempSync(join(tmpdir(), 'literal-gate-'));
    dirs.push(root);
    const write = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write(ALLOW_FILE, JSON.stringify({ files: allow }));
    for (const [path, text] of Object.entries(files)) write(path, text);
    return root;
  };

  it('scans package sources, server-kit and preview, but not their tests', () => {
    const root = repo({
      'packages/hub/src/a.ts': "if (host === 'x') {}",
      'packages/hub/test/a.test.ts': "if (host === 'x') {}",
      'packages/hub/src/a.test.ts': "if (host === 'x') {}",
      'server-kit/luady_kit/hook.py': "if host == 'x':\n    pass\nNAME = 'hq'",
      'server-kit/tests/test_hook.py': "NAME = 'hq'",
      'preview/main.ts': "fleet.client('hq');",
      'preview/test/main.test.ts': "fleet.client('hq');",
    }, []);
    const { hits } = checkRepository(root);
    assert.deepEqual(hits.map((hit) => `${hit.path}:${hit.rule}`), [
      'packages/hub/src/a.ts:host-compare',
      'preview/main.ts:host-call',
      'preview/main.ts:self-host-literal',
      'server-kit/luady_kit/hook.py:host-compare',
      'server-kit/luady_kit/hook.py:self-host-literal',
    ]);
  });

  it('needs a reason for every allow-list entry, and an entry that is a scanned file', () => {
    const root = repo({ 'packages/office/src/teams.ts': "const x = 'hq';" }, [
      { path: 'packages/office/src/teams.ts', reason: '' },
      { path: 'packages/office/src/gone.ts', reason: 'the HQ room key' },
    ]);
    const { problems } = checkRepository(root);
    assert.equal(problems.length, 2);
  });

  it('passes on this repository', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const { hits, problems } = checkRepository(root);
    assert.deepEqual(problems, []);
    assert.deepEqual(hits.map((hit) => `${hit.path}:${hit.line}: ${hit.rule}`), []);
  });
});
