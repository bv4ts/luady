import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { FLEET_KEY_COMMENT, KEY_OPTIONS, ensureFleetKey, keyLine, loadFleetKey, validateKeyBlob, writeNew } from '../../src/fleet/fleet-key.js';
import { fingerprintSha256 } from '../../src/fleet/host-key.js';

const fresh = (): string => join(mkdtempSync(join(tmpdir(), 'luady-fleet-key-')), 'data', 'fleet_ed25519');
const POSIX = process.platform !== 'win32';

function hasSshKeygen(): boolean {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return (err as { status?: number }).status !== undefined && (err as { code?: string }).code !== 'ENOENT';
  }
}

describe('the fleet key', () => {
  it('is generated once: a second start loads the same pair and never rewrites it', () => {
    const path = fresh();
    const first = ensureFleetKey(path);
    const privateText = readFileSync(path, 'utf8');
    const second = ensureFleetKey(path);
    expect(second.blob).toBe(first.blob);
    expect(readFileSync(path, 'utf8')).toBe(privateText);
    expect(readFileSync(`${path}.pub`, 'utf8')).toBe(`${first.publicKey}\n`);
    expect(first.publicKey).toBe(`ssh-ed25519 ${first.blob} ${FLEET_KEY_COMMENT}`);
    expect(first.fingerprint).toBe(fingerprintSha256(Buffer.from(first.blob, 'base64')));
  });

  it('writes an OpenSSH private key that ssh2 parses, whose public half is the blob, and which signs', () => {
    const path = fresh();
    const key = ensureFleetKey(path);
    const parsed = ssh2.utils.parseKey(readFileSync(path));
    if (parsed instanceof Error) throw parsed;
    expect(parsed.type).toBe('ssh-ed25519');
    expect(parsed.getPublicSSH().toString('base64')).toBe(key.blob);
    const data = Buffer.from('fleet');
    const signature = parsed.sign(data);
    expect(signature instanceof Error).toBe(false);
    expect(parsed.verify(data, signature as Buffer)).toBe(true);
  });

  it.runIf(POSIX)('private key 0600, .pub 0644, folder 0700', () => {
    const path = fresh();
    ensureFleetKey(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}.pub`).mode & 0o777).toBe(0o644);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
  });

  it.runIf(hasSshKeygen())('ssh-keygen -y derives the same public key from the private file', () => {
    const path = fresh();
    const key = ensureFleetKey(path);
    const derived = execFileSync('ssh-keygen', ['-y', '-f', path], { encoding: 'utf8' }).trim();
    expect(derived.split(' ').slice(0, 2).join(' ')).toBe(`ssh-ed25519 ${key.blob}`);
  });

  it('rewrites a missing .pub from the private key, never the private key itself', () => {
    const path = fresh();
    const key = ensureFleetKey(path);
    const privateText = readFileSync(path, 'utf8');
    writeFileSync(`${path}.pub`, 'garbage\n');
    expect(loadFleetKey(path).blob).toBe(key.blob);
    expect(ensureFleetKey(path).blob).toBe(key.blob);
    expect(readFileSync(`${path}.pub`, 'utf8')).toBe(`${key.publicKey}\n`);
    expect(readFileSync(path, 'utf8')).toBe(privateText);
  });

  it('builds the key line, with from= only when fleetFrom is set', () => {
    const path = fresh();
    const key = ensureFleetKey(path);
    expect(keyLine(key)).toBe(`${KEY_OPTIONS} ssh-ed25519 ${key.blob} ${FLEET_KEY_COMMENT}`);
    expect(keyLine(key, [])).toBe(`${KEY_OPTIONS} ssh-ed25519 ${key.blob} ${FLEET_KEY_COMMENT}`);
    expect(keyLine(key, ['192.0.2.10', '198.51.100.0/24', '2001:db8::/32'])).toBe(
      `${KEY_OPTIONS},from="192.0.2.10,198.51.100.0/24,2001:db8::/32" ssh-ed25519 ${key.blob} ${FLEET_KEY_COMMENT}`,
    );
    expect(KEY_OPTIONS).toBe('no-port-forwarding,no-agent-forwarding,no-X11-forwarding');
  });

  it('writes the private key through a temp file and a hard link: no half key, no overwrite, nothing left over', () => {
    const path = fresh();
    ensureFleetKey(path);
    const folder = join(path, '..');
    expect(readdirSync(folder).sort()).toEqual(['fleet_ed25519', 'fleet_ed25519.pub']);
    const before = readFileSync(path, 'utf8');
    expect(writeNew(path, 'something else', 0o600)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(folder).sort()).toEqual(['fleet_ed25519', 'fleet_ed25519.pub']);
    const other = join(folder, 'other');
    expect(writeNew(other, 'text', 0o600)).toBe(true);
    expect(readFileSync(other, 'utf8')).toBe('text');
  });

  it('says at start what to do about a key with a passphrase, a key of another type, or a file that is no key', () => {
    const cases: Array<[string, string | Buffer, RegExp]> = [
      ['encrypted', ssh2.utils.generateKeyPairSync('ed25519', { passphrase: 'pass phrase', cipher: 'aes256-ctr' }).private, /protected with a passphrase.*ssh-keygen -p -f/],
      ['ecdsa', ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private, /is a key of type ecdsa-sha2-nistp256; the hub uses an ed25519 key\. Move it aside/],
      ['garbage', 'not a key at all\n', /is not a private key the hub can read\. Move it aside/],
    ];
    for (const [name, text, message] of cases) {
      const path = fresh();
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
      expect(() => ensureFleetKey(path), name).toThrow(message);
      expect(readFileSync(path).equals(Buffer.from(text)), name).toBe(true);
    }
  });

  it('refuses a from= entry that is not an address or a network, and a blob that is not ed25519', () => {
    const key = ensureFleetKey(fresh());
    for (const bad of ['*', 'example.com', '192.0.2.1"', '192.0.2.1,198.51.100.1', '192.0.2.0/33', '', 'fe80::1%eth0', 'fe80::%25eth0/64']) {
      expect(() => keyLine(key, [bad]), bad).toThrow(ValidationError);
    }
    expect(() => validateKeyBlob('AAAAB3NzaC1yc2EAAAADAQABAAABAQ')).toThrow(ValidationError);
    expect(() => validateKeyBlob(`${key.blob}'`)).toThrow(ValidationError);
    expect(() => validateKeyBlob('')).toThrow(ValidationError);
    expect(validateKeyBlob(key.blob)).toBe(key.blob);
  });
});
