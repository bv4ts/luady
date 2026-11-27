import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The public release is Apache-2.0: the LICENSE file says so, and every package.json repeats it. */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const LICENCE = 'Apache-2.0';

const licenceOf = (dir: string): unknown => (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { license?: unknown }).license;

describe('release: the licence', () => {
  it('the LICENSE file is the Apache License 2.0', () => {
    expect(readFileSync(join(ROOT, 'LICENSE'), 'utf8')).toMatch(/Apache License\s+Version 2\.0/);
  });

  it('the root and every workspace package declare it', () => {
    const packages = readdirSync(join(ROOT, 'packages')).sort();
    expect(packages.length).toBeGreaterThanOrEqual(6);
    const found = [['(root)', licenceOf(ROOT)], ...packages.map((name) => [name, licenceOf(join(ROOT, 'packages', name))])];
    expect(found.filter(([, licence]) => licence !== LICENCE)).toEqual([]);
  });
});
