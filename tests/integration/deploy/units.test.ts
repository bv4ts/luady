import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInDeployImage } from '../harness/deploy-image.js';
import { REPO_ROOT } from '../harness/paths.js';

const UNIT_DIR = join(REPO_ROOT, 'deploy', 'systemd');
/** The VPS install's system units (provision.sh embeds them). */
const UNITS = ['luady-hub.service', 'luady-backup.service', 'luady-backup.timer'] as const;
/** A fresh install's user unit: the hub as the user who cloned it (`luady start`). */
const USER_UNIT = 'luady.user.service';
const HARDENING: ReadonlyArray<readonly [string, string]> = [
  ['User', 'luady'], ['Group', 'luady'], ['NoNewPrivileges', 'yes'], ['PrivateTmp', 'yes'],
  ['ProtectSystem', 'full'], ['ReadWritePaths', '/home/luady'], ['UMask', '0077'],
];

function directives(unit: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const raw of readFileSync(join(UNIT_DIR, unit), 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('[')) continue;
    const at = line.indexOf('=');
    const key = line.slice(0, at);
    map.set(key, [...(map.get(key) ?? []), line.slice(at + 1)]);
  }
  return map;
}

describe('systemd units', () => {
  it('luady-hub runs as luady with its hardening and resource limits, KillMode=process and a tmux socket outside PrivateTmp', () => {
    const d = directives('luady-hub.service');
    for (const [key, value] of HARDENING) expect(d.get(key), key).toEqual([value]);
    expect(d.get('WorkingDirectory')).toEqual(['/home/luady/app/current']);
    expect(d.get('ExecStart')).toEqual(['/home/luady/.local/bin/node packages/hub/dist/main.js']);
    expect(d.get('Environment')).toEqual(expect.arrayContaining([
      'LUADY_CONFIG=/home/luady/.config/luady/config.json', 'LUADY_SECRETS=/home/luady/.config/luady/secrets.env',
      'TMUX_TMPDIR=/home/luady/run', 'TMPDIR=/home/luady/run/tmp',
      'PATH=/home/luady/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin',
    ]));
    expect(d.get('Restart')).toEqual(['always']);
    expect(d.get('KillMode')).toEqual(['process']);
    expect(d.get('MemoryMax')).toEqual(['2G']);
    expect(d.get('CPUQuota')).toEqual(['200%']);
    expect(d.get('ConditionPathExists')).toContain('/home/luady/.config/luady/config.json');
  });

  it('luady-hub does not depend on cloudflared, so a tunnel restart never stops or restarts the hub', () => {
    const text = readFileSync(join(UNIT_DIR, 'luady-hub.service'), 'utf8');
    expect(text).not.toMatch(/^(Requires|Requisite|BindsTo|PartOf|After|Wants|Upholds)=.*cloudflared/m);
  });

  it('ships only the hub (system and user) and the backup: add-ons run as their own services, outside this tree', () => {
    expect(readdirSync(UNIT_DIR).sort()).toEqual([...UNITS, USER_UNIT].sort());
  });

  it('the user unit runs `luady start` from the clone as the user, keeps its tmux servers on restart, and starts at login', () => {
    const d = directives(USER_UNIT);
    expect(d.get('ExecStart')).toEqual(['/usr/bin/env node packages/hub/dist/cli.js start']);
    expect(d.get('WorkingDirectory')).toEqual(['%h/luady']);
    expect(d.get('Restart')).toEqual(['on-failure']);
    expect(d.get('KillMode')).toEqual(['process']);
    expect(d.get('UMask')).toEqual(['0077']);
    expect(d.get('WantedBy')).toEqual(['default.target']);
    // A user unit runs as its user: no User=, no system paths to own, no Access or deploy-only variables.
    for (const key of ['User', 'Group', 'ReadWritePaths', 'ConditionPathExists']) expect(d.has(key), key).toBe(false);
    expect((d.get('Environment') ?? []).join(' ')).not.toMatch(/LUADY_CONFIG|LUADY_SECRETS/);
  });

  it('the backup timer runs daily at 04:30 server local time and catches up after downtime', () => {
    expect(directives('luady-backup.timer').get('OnCalendar')).toEqual(['*-*-* 04:30:00']);
    expect(directives('luady-backup.timer').get('Persistent')).toEqual(['true']);
    expect(directives('luady-backup.service').get('Type')).toEqual(['oneshot']);
    expect(directives('luady-backup.service').get('ExecStart')).toEqual(['/bin/bash /home/luady/app/current/deploy/backup.sh']);
  });

  it('every unit uses LF line endings', () => {
    for (const unit of [...UNITS, USER_UNIT]) expect(readFileSync(join(UNIT_DIR, unit), 'utf8').includes('\r'), unit).toBe(false);
  });

  it('systemd-analyze verify accepts every unit', async () => {
    const result = await runInDeployImage('bash /work/tests/integration/deploy/units-verify.sh', { network: false });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('UNITS VERIFY OK');
  });
});
