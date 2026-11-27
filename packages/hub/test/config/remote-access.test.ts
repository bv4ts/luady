import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StartupRefusal } from '../../src/config/refusals.js';
import { openDb } from '../../src/db/open.js';
import { runHub, type RunningHub } from '../../src/main.js';
import { silentLogger } from '../helpers/fakes.js';

const { join } = posix;
const AUD = 'a'.repeat(32);
let running: RunningHub | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
});

/** A home with config.json (and, when given, secrets.env) at the default paths, and a built website folder. */
function home(config: Record<string, unknown>, secrets?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'luady-remote-'));
  const web = join(dir, 'web');
  mkdirSync(web, { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Hub</title>');
  mkdirSync(join(dir, '.config', 'luady'), { recursive: true });
  writeFileSync(join(dir, '.config', 'luady', 'config.json'), JSON.stringify({ webDir: web, ...config }));
  if (secrets !== undefined) writeFileSync(join(dir, '.config', 'luady', 'secrets.env'), secrets);
  return dir;
}

function withPasskey(dir: string): void {
  const db = openDb(join(dir, '.local', 'share', 'luady', 'data', 'hub.db'));
  db.prepare("INSERT INTO auth_passkeys (cred_id, public_key, counter, transports_json, label, created_at) VALUES ('c1', x'00', 0, '[]', 'Phone', ?)")
    .run('2026-11-21T08:00:00.000Z');
  db.close();
}

async function refusal(dir: string): Promise<StartupRefusal> {
  try {
    running = await runHub({ env: {}, home: dir, log: silentLogger(), listen: false });
  } catch (err) {
    if (err instanceof StartupRefusal) return err;
    throw err;
  }
  throw new Error('expected a startup refusal');
}

const REMOTE = { publicOrigin: 'https://hub.example', allowRemote: true };

describe('remote installs and the passkey rule', () => {
  it('bindHost 127.0.0.1 behind https://hub.example is remote: with no passkey a local-mode hub refuses to start', async () => {
    const refused = await refusal(home({ ...REMOTE, bindHost: '127.0.0.1' }));
    expect(refused.refusal).toBe('remote-no-passkey');
    expect(refused.message.split('\n')).toHaveLength(1);
  });

  it('the same install with a passkey and allowRemote starts', async () => {
    const dir = home(REMOTE);
    withPasskey(dir);
    running = await runHub({ env: {}, home: dir, log: silentLogger(), listen: false });
    expect(running.config).toMatchObject({ publicOrigin: 'https://hub.example', authMode: 'local', allowRemote: true });
  });

  it('a new cloudflare-access install with no passkey starts: Access is the outer gate, the setup code guards the claim', async () => {
    const dir = home(
      { ...REMOTE, authMode: 'cloudflare-access', cfTeamDomain: 'team.cloudflareaccess.com', ownerEmail: 'owner@example.com' },
      `CF_ACCESS_AUD=${AUD}\n`,
    );
    running = await runHub({ env: {}, home: dir, log: silentLogger(), listen: false });
    expect(running.config).toMatchObject({ authMode: 'cloudflare-access', trustedProxy: 'cloudflare' });
  });

  it('a local install (loopback, http://localhost) starts with no passkey and guesses no owner zone: the claim sets it', async () => {
    const dir = home({});
    running = await runHub({ env: {}, home: dir, log: silentLogger(), listen: false });
    expect(running.config.publicOrigin).toBe('http://localhost:7410');
    expect(running.app.services.settings.get().owner_tz).toBeNull();
  });

  it('through runHub: a database sealed under another secret refuses to start', async () => {
    const dir = home({});
    running = await runHub({ env: {}, home: dir, log: silentLogger(), listen: false });
    await running.stop();
    running = null;
    const db = openDb(join(dir, '.local', 'share', 'luady', 'data', 'hub.db'));
    db.prepare("INSERT INTO google_accounts (email, label, refresh_enc, added_at) VALUES ('owner@example.com', 'work', ?, '2026-11-21T08:00:00Z')")
      .run('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    db.close();
    expect((await refusal(dir)).refusal).toBe('secrets-mismatch');
  });
});
