import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInDeployImage } from '../harness/deploy-image.js';
import { REPO_ROOT } from '../harness/paths.js';

const UNITS = ['luady-hub.service', 'luady-backup.service', 'luady-backup.timer'] as const;
const provision = (): string => readFileSync(join(REPO_ROOT, 'deploy', 'provision.sh'), 'utf8');

function embeddedUnit(name: string): string {
  const text = provision();
  const marker = `write_unit ${name} <<'UNIT'\n`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`provision.sh does not embed ${name}`);
  const lines = text.slice(start + marker.length).split('\n');
  return `${lines.slice(0, lines.indexOf('UNIT')).join('\n')}\n`;
}

describe('deploy/provision.sh', () => {
  it.each(UNITS)('embeds %s byte-for-byte', (unit) => {
    expect(embeddedUnit(unit)).toBe(readFileSync(join(REPO_ROOT, 'deploy', 'systemd', unit), 'utf8'));
  });

  it('writes no other unit than these', () => {
    expect([...provision().matchAll(/write_unit (\S+) <<'UNIT'/g)].map((m) => m[1]).sort()).toEqual([...UNITS].sort());
  });

  it('never restarts services it did not install, touches sshd/ufw or upgrades packages, and suspends needrestart', () => {
    const text = provision();
    expect(text).not.toMatch(/systemctl\s+(restart|reload|stop)\s+(nginx|docker|ssh|sshd|pm2)|\bufw\s+(allow|deny|enable|disable|reset|delete)|sshd_config|apt-get[^\n]*\bupgrade\b|chpasswd|passwd root/);
    expect(text).toContain('NEEDRESTART_SUSPEND=1');
    expect(text.trimEnd().endsWith('main "$@" </dev/null')).toBe(true);
  });

  it.skipIf(process.env.LUADY_IT_PROVISION !== '1')('is idempotent in a fresh Ubuntu 24.04 container (needs network; LUADY_IT_PROVISION=1)', async () => {
    const result = await runInDeployImage('bash /work/tests/integration/deploy/provision-test.sh', { timeoutMs: 1_800_000 });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('PROVISION TEST OK');
  }, 1_800_000);
});
