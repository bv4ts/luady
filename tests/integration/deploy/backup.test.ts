import { describe, expect, it } from 'vitest';
import { runInDeployImage } from '../harness/deploy-image.js';

describe('deploy/backup.sh', () => {
  it('backs up a live WAL database and the brain, prunes to 14 and keeps files private', async () => {
    const result = await runInDeployImage('bash /work/tests/integration/deploy/backup-test.sh', { network: false });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('BACKUP TEST OK');
  });
});
