import { describe, expect, it } from 'vitest';
import { runBash } from '../harness/bash.js';
import { runInDeployImage } from '../harness/deploy-image.js';

const REQUIRED = [
  'package.json', 'package-lock.json', 'RELEASE', 'packages/shared/package.json', 'packages/hub/dist/main.js',
  'packages/hub/dist/cli.js', 'packages/mcp/dist/main.js', 'packages/web/dist/index.html',
  'brain/CLAUDE.md', 'server-kit/install.py', 'deploy/backup.sh',
];

describe('deploy/remote/activate.sh', () => {
  it('activates, keeps memory, rolls a broken release back automatically, rolls back on demand and keeps 5', async () => {
    const result = await runInDeployImage('bash /work/tests/integration/deploy/activate-test.sh', {
      network: false, env: { LUADY_HEALTH_TRIES: '3' },
    });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('ACTIVATE TEST OK');
  }, 600_000);
});

describe('deploy/deploy.sh --pack-only', () => {
  it('packs every file the activation requires and nothing from node_modules', async () => {
    const packed = await runBash(['deploy/deploy.sh', '--skip-build', '--pack-only']);
    expect(packed.code, packed.stderr).toBe(0);
    const tarball = packed.stdout.trim().split('\n').pop() ?? '';
    const listing = await runBash(['-c', 'tar -tzf "$1" && rm -f "$1"', 'list', tarball]);
    expect(listing.code, listing.stderr).toBe(0);
    const entries = listing.stdout.split('\n').map((entry) => entry.replace(/^\.\//, ''));
    for (const file of REQUIRED) expect(entries, file).toContain(file);
    expect(entries.some((entry) => entry.includes('node_modules/'))).toBe(false);
  });
});
