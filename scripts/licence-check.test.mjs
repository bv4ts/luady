import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EXCEPTIONS,
  OUTPUT_FILE,
  collectPackages,
  evaluate,
  findLockfiles,
  judgeLicence,
  licenceOfEntry,
  renderReport,
  run,
} from './licence-check.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'licence-check.mjs');
const made = [];
const tempRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'licence-check-'));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const writeJson = (root, rel, value) => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};
const lock = (packages) => ({ name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' }, ...packages } });
const silent = { log() {}, error() {} };

describe('licence-check: judging a licence expression', () => {
  it('passes permissive licences and choices with a permissive side', () => {
    for (const text of ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'MPL-2.0', 'OFL-1.1', '(MPL-2.0 OR Apache-2.0)', '(MIT OR EUPL-1.1+)', 'mit or apache-2.0', '(MIT OR GPL-3.0-only)']) {
      assert.equal(judgeLicence(text).verdict, 'ok', text);
    }
  });

  it('fails GPL, LGPL, AGPL and SSPL in every spelling', () => {
    for (const text of ['GPL-3.0', 'GPL-2.0-only', 'GPL-3.0-or-later', 'GPL-2.0+', 'LGPL-2.1', 'LGPL-3.0-or-later', 'AGPL-3.0', 'AGPL-3.0-only', 'SSPL-1.0', 'gpl-3.0']) {
      assert.equal(judgeLicence(text).verdict, 'denied', text);
    }
  });

  it('fails an AND that holds a denied licence, a WITH exception on a denied licence, and nested cases', () => {
    assert.equal(judgeLicence('Apache-2.0 AND LGPL-3.0-or-later').verdict, 'denied');
    assert.equal(judgeLicence('Apache-2.0 AND LGPL-3.0-or-later AND MIT').verdict, 'denied');
    assert.equal(judgeLicence('GPL-2.0 WITH Classpath-exception-2.0').verdict, 'denied');
    assert.equal(judgeLicence('MIT AND (GPL-2.0 OR LGPL-2.1)').verdict, 'denied');
    assert.equal(judgeLicence('(GPL-2.0 OR LGPL-2.1)').verdict, 'denied');
    assert.deepEqual(judgeLicence('Apache-2.0 AND LGPL-3.0-or-later').denied, ['LGPL-3.0-or-later']);
  });

  it('passes a WITH exception on a permissive licence', () => {
    assert.equal(judgeLicence('Apache-2.0 WITH LLVM-exception').verdict, 'ok');
  });

  it('flags weak copyleft only when the expression cannot avoid it', () => {
    assert.deepEqual(judgeLicence('MPL-2.0').weak, ['MPL-2.0']);
    assert.deepEqual(judgeLicence('(MPL-2.0 OR Apache-2.0)').weak, []);
    assert.deepEqual(judgeLicence('(MIT OR EUPL-1.1+)').weak, []);
    assert.equal(judgeLicence('MPL-2.0').verdict, 'ok');
  });

  it('does not accept free text, a missing value, or UNLICENSED', () => {
    assert.equal(judgeLicence('SEE LICENSE IN LICENSE.md').verdict, 'unparseable');
    assert.equal(judgeLicence('Custom: https://example.com/terms').verdict, 'unparseable');
    assert.equal(judgeLicence('(MIT OR').verdict, 'unparseable');
    assert.equal(judgeLicence('').verdict, 'missing');
    assert.equal(judgeLicence(undefined).verdict, 'missing');
    assert.equal(judgeLicence('UNLICENSED').verdict, 'denied');
  });
});

describe('licence-check: reading the licence of a lockfile entry', () => {
  it('reads the license string, and the legacy object and array shapes', () => {
    assert.equal(licenceOfEntry({ license: 'MIT' }), 'MIT');
    assert.equal(licenceOfEntry({ license: { type: 'ISC' } }), 'ISC');
    assert.equal(licenceOfEntry({ license: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }), '(MIT OR Apache-2.0)');
    assert.equal(licenceOfEntry({ license: '  ' }), undefined);
    assert.equal(licenceOfEntry({}), undefined);
  });
});

describe('licence-check: finding and reading lockfiles', () => {
  it('finds every package-lock.json outside node_modules and .git, with forward slashes', () => {
    const root = tempRoot();
    writeJson(root, 'package-lock.json', lock({}));
    writeJson(root, 'tests/integration/package-lock.json', lock({}));
    writeJson(root, 'node_modules/foo/package-lock.json', lock({}));
    writeJson(root, '.git/package-lock.json', lock({}));
    assert.deepEqual(findLockfiles(root), ['package-lock.json', 'tests/integration/package-lock.json']);
  });

  it('skips the root entry, workspace folders and links, and names nested, scoped and aliased packages', () => {
    const root = tempRoot();
    writeJson(
      root,
      'package-lock.json',
      lock({
        'packages/hub': { name: '@x/hub', version: '1.0.0', license: 'Apache-2.0' },
        'node_modules/@x/hub': { resolved: 'packages/hub', link: true },
        'node_modules/a': { version: '1.0.0', license: 'MIT' },
        'node_modules/a/node_modules/b': { version: '2.0.0', license: 'ISC', dev: true },
        'node_modules/@s/c': { version: '3.0.0', license: 'BSD-2-Clause' },
        'node_modules/alias': { name: 'real', version: '4.0.0', license: 'MIT' },
      }),
    );
    const { packages } = collectPackages(root);
    assert.deepEqual(
      packages.map((p) => `${p.name}@${p.version}:${p.dev ? 'dev' : 'runtime'}`),
      ['a@1.0.0:runtime', 'b@2.0.0:dev', '@s/c@3.0.0:runtime', 'real@4.0.0:runtime'],
    );
  });
});

describe('licence-check: evaluating packages', () => {
  const pkg = (name, version, licence, dev = false, lockfile = 'package-lock.json') => ({ name, version, licence, dev, lockfile });
  const exception = (over = {}) => ({ name: 'old', version: '1.0.0', licence: 'MIT', reason: 'no field', verified: 'LICENSE is MIT', ...over });

  it('passes permissive packages', () => {
    const result = evaluate([pkg('a', '1.0.0', 'MIT')], []);
    assert.deepEqual(result.failures, []);
    assert.equal(result.rows[0].licence, 'MIT');
  });

  it('fails a denied licence and an unparseable one', () => {
    const { failures } = evaluate([pkg('g', '1.0.0', 'GPL-3.0'), pkg('t', '1.0.0', 'SEE LICENSE IN X')], []);
    assert.equal(failures.length, 2);
    assert.match(failures[0], /g@1\.0\.0/);
    assert.match(failures[0], /GPL-3\.0/);
    assert.match(failures[1], /t@1\.0\.0/);
  });

  it('fails a missing licence that is not on the exceptions list', () => {
    const { failures } = evaluate([pkg('old', '2.0.0', undefined)], [exception()]);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /old@2\.0\.0/);
    assert.match(failures[0], /no licence/);
  });

  it('accepts a missing licence that is on the list for exactly that version, and reports it as used', () => {
    const result = evaluate([pkg('old', '1.0.0', undefined)], [exception()]);
    assert.deepEqual(result.failures, []);
    assert.equal(result.rows[0].licence, 'MIT');
    assert.equal(result.rows[0].fromException, true);
    assert.deepEqual(result.usedExceptions.map((e) => e.name), ['old']);
    assert.deepEqual(result.unusedExceptions, []);
  });

  it('reports an exception that matched nothing as unused, without failing', () => {
    const result = evaluate([pkg('a', '1.0.0', 'MIT')], [exception()]);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.unusedExceptions.map((e) => e.name), ['old']);
  });

  it('does not let an exception supply a denied licence', () => {
    const { failures } = evaluate([pkg('old', '1.0.0', undefined)], [exception({ licence: 'GPL-3.0' })]);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /GPL-3\.0/);
  });

  it('does not let an exception override a licence the package declares', () => {
    const result = evaluate([pkg('old', '1.0.0', 'ISC')], [exception()]);
    assert.equal(result.rows[0].licence, 'ISC');
    assert.deepEqual(result.unusedExceptions.map((e) => e.name), ['old']);
  });

  it('merges one name@version from two lockfiles: runtime wins over dev', () => {
    const result = evaluate([pkg('v', '1.0.0', 'MIT', true, 'tests/integration/package-lock.json'), pkg('v', '1.0.0', 'MIT', false)], []);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].dev, false);
  });

  it('ships exceptions that are complete and not denied', () => {
    assert.ok(EXCEPTIONS.length > 0 && EXCEPTIONS.length <= 5);
    for (const entry of EXCEPTIONS) {
      for (const key of ['name', 'version', 'licence', 'reason', 'verified']) {
        assert.equal(typeof entry[key], 'string', `${entry.name}.${key}`);
        assert.notEqual(entry[key].trim(), '', `${entry.name}.${key}`);
      }
      assert.equal(judgeLicence(entry.licence).verdict, 'ok', entry.name);
    }
  });
});

describe('licence-check: the report', () => {
  const rows = [
    { name: 'zeta', version: '1.0.0', licence: 'MIT', dev: false },
    { name: 'alpha', version: '2.0.0', licence: 'MIT', dev: true },
    { name: 'beta', version: '1.0.0', licence: 'ISC', dev: false },
    { name: 'old', version: '1.0.0', licence: 'MIT', dev: false, fromException: true },
  ];
  const options = { lockfiles: ['package-lock.json'], usedExceptions: [{ name: 'old', version: '1.0.0', licence: 'MIT', reason: 'no field', verified: 'LICENSE is MIT' }] };

  it('groups by licence, most packages first, sorted by name inside a group', () => {
    const text = renderReport(rows, options);
    assert.ok(text.indexOf('## MIT (3)') < text.indexOf('## ISC (1)'));
    assert.ok(text.indexOf('| alpha | 2.0.0 | dev |') < text.indexOf('| old | 1.0.0 | runtime |'));
    assert.ok(text.indexOf('| old | 1.0.0 | runtime |') < text.indexOf('| zeta | 1.0.0 | runtime |'));
  });

  it('names the lockfiles and the reviewed exceptions, and has no date', () => {
    const text = renderReport(rows, options);
    assert.match(text, /`package-lock\.json`/);
    assert.match(text, /reviewed exception/i);
    assert.match(text, /old@1\.0\.0/);
    assert.doesNotMatch(text, /20\d\d-\d\d-\d\d/);
  });

  it('is identical for the same input in any order', () => {
    assert.equal(renderReport(rows, options), renderReport([...rows].reverse(), options));
  });
});

describe('licence-check: the whole run', () => {
  it('writes the report when every package passes', () => {
    const root = tempRoot();
    writeJson(root, 'package-lock.json', lock({ 'node_modules/a': { version: '1.0.0', license: 'MIT' } }));
    const result = run(root, { ...silent, exceptions: [] });
    assert.equal(result.ok, true);
    assert.match(readFileSync(join(root, OUTPUT_FILE), 'utf8'), /\| a \| 1\.0\.0 \| runtime \|/);
  });

  it('fails, and leaves an existing report alone, when a package is GPL', () => {
    const root = tempRoot();
    writeFileSync(join(root, OUTPUT_FILE), 'old report');
    writeJson(root, 'package-lock.json', lock({ 'node_modules/g': { version: '1.0.0', license: 'GPL-3.0' } }));
    const result = run(root, { ...silent, exceptions: [] });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(join(root, OUTPUT_FILE), 'utf8'), 'old report');
  });

  it('fails when there is no lockfile at all', () => {
    assert.equal(run(tempRoot(), { ...silent, exceptions: [] }).ok, false);
  });

  it('exits 1 and names the package from the command line, exits 0 when clean', () => {
    const bad = tempRoot();
    writeJson(bad, 'package-lock.json', lock({ 'node_modules/g': { version: '1.0.0', license: 'AGPL-3.0' } }));
    const failed = spawnSync(process.execPath, [SCRIPT, '--root', bad], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /g@1\.0\.0/);

    const good = tempRoot();
    writeJson(good, 'package-lock.json', lock({ 'node_modules/a': { version: '1.0.0', license: 'MIT' } }));
    const passed = spawnSync(process.execPath, [SCRIPT, '--root', good], { encoding: 'utf8' });
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /licence-check: ok/);
  });
});
