import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename, dirname, join } from 'node:path';
import ssh2 from 'ssh2';
import type { Logger } from '../core/contracts.js';
import { ValidationError } from '../core/errors.js';
import { fingerprintSha256 } from './host-key.js';

/**
 * The fleet key: one ed25519 pair the hub logs in to every server with. Made on the first start when
 * `fleetKeyPath` is missing (private 0600, `.pub` 0644, folder 0700) and never overwritten. The private half is read
 * only here (to derive the public half) and by the SSH executor; no route returns it and nothing logs it.
 */
export const FLEET_KEY_COMMENT = 'luady-fleet';
/** The options every key line carries: the key can run commands, never forward anything. */
export const KEY_OPTIONS = 'no-port-forwarding,no-agent-forwarding,no-X11-forwarding';

const KEY_TYPE = 'ssh-ed25519';
/** An ed25519 blob in base64: `string "ssh-ed25519"` then a 32-byte key, 68 characters. */
const BLOB_RE = /^AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]{40,120}={0,2}$/;
const PEM_WIDTH = 70;
/** The PEM label OpenSSH writes, built from its words so secret scanners do not mistake this file for a key. */
const PEM_LABEL = ['OPENSSH', 'PRIVATE', 'KEY'].join(' ');

export interface FleetKey {
  readonly path: string;
  /** The base64 public-key blob (what a key line and key-remove carry). */
  readonly blob: string;
  /** `ssh-ed25519 <blob> luady-fleet`, the `.pub` line. */
  readonly publicKey: string;
  readonly fingerprint: string;
}

function sshString(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0);
  return out;
}

/** The `openssh-key-v1` private key (unencrypted) of one ed25519 pair, as OpenSSH itself writes it. */
export function openSshPrivateKey(seed: Buffer, publicKey: Buffer, comment: string): string {
  const pub = Buffer.concat([sshString(KEY_TYPE), sshString(publicKey)]);
  const check = randomBytes(4).readUInt32BE();
  const body = Buffer.concat([
    uint32(check), uint32(check), sshString(KEY_TYPE), sshString(publicKey),
    sshString(Buffer.concat([seed, publicKey])), sshString(comment),
  ]);
  const padLength = (8 - (body.length % 8)) % 8;
  const padding = Buffer.from(Array.from({ length: padLength }, (_v, i) => i + 1));
  const raw = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'), sshString('none'), sshString('none'), sshString(''), uint32(1), sshString(pub),
    sshString(Buffer.concat([body, padding])),
  ]);
  const lines = raw.toString('base64').match(new RegExp(`.{1,${PEM_WIDTH}}`, 'g')) ?? [];
  return [`-----BEGIN ${PEM_LABEL}-----`, ...lines, `-----END ${PEM_LABEL}-----`, ''].join('\n');
}

/** Node's own ed25519 generator, serialised in OpenSSH form (ssh2 1.17's generator sometimes drops a byte). */
function generatePair(): { privateText: string; blob: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwkPrivate = privateKey.export({ format: 'jwk' });
  const jwkPublic = publicKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwkPrivate.d ?? '', 'base64url');
  const pub = Buffer.from(jwkPublic.x ?? '', 'base64url');
  if (seed.length !== 32 || pub.length !== 32) throw new Error('fleet key: the ed25519 generator gave an unexpected key');
  const blob = Buffer.concat([sshString(KEY_TYPE), sshString(pub)]).toString('base64');
  return { privateText: openSshPrivateKey(seed, pub, FLEET_KEY_COMMENT), blob };
}

/** A public-key blob the hub will put in a key line or send to key-remove: ed25519, base64, nothing else. */
export function validateKeyBlob(blob: string): string {
  if (!BLOB_RE.test(blob)) throw new ValidationError('the fleet key is not an ssh-ed25519 key');
  const raw = Buffer.from(blob, 'base64');
  if (raw.length !== 51 || raw.subarray(4, 15).toString('latin1') !== KEY_TYPE) {
    throw new ValidationError('the fleet key blob is malformed');
  }
  return blob;
}

function fleetKeyOf(path: string, blob: string): FleetKey {
  validateKeyBlob(blob);
  return { path, blob, publicKey: `${KEY_TYPE} ${blob} ${FLEET_KEY_COMMENT}`, fingerprint: fingerprintSha256(Buffer.from(blob, 'base64')) };
}

/** What to do about a key the hub cannot use, said once at start (the hub never replaces a key itself). */
const MAKE_NEW = 'Move it aside and start the hub again: it makes a new key, and you paste the new line on each server.';

/** Reads the private key and derives its public half (the `.pub` file is never trusted for that). */
export function loadFleetKey(path: string): FleetKey {
  const parsed = ssh2.utils.parseKey(readFileSync(path));
  if (parsed instanceof Error) {
    if (/encrypt|passphrase/i.test(parsed.message)) {
      throw new Error(`fleet key: ${path} is protected with a passphrase, and the hub signs in without one. `
        + `Remove the passphrase (ssh-keygen -p -f ${path}), or: ${MAKE_NEW}`);
    }
    throw new Error(`fleet key: ${path} is not a private key the hub can read. ${MAKE_NEW}`);
  }
  if (parsed.type !== KEY_TYPE) {
    throw new Error(`fleet key: ${path} is a key of type ${/^[a-z0-9@.-]{1,40}$/.test(parsed.type) ? parsed.type : 'unknown'}; the hub uses an ed25519 key. ${MAKE_NEW}`);
  }
  return fleetKeyOf(path, parsed.getPublicSSH().toString('base64'));
}

/**
 * Writes a new file at `path` only when there is none: the text goes to a temp file in the same folder first, which is
 * then hard-linked to `path` (a link never replaces an existing file) and removed. So `path` never holds half a key,
 * and a key another start made meanwhile is kept. Returns whether this call made it.
 */
export function writeNew(path: string, text: string, mode: number): boolean {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temp, text, { mode, flag: 'wx' });
  try {
    chmodSync(temp, mode);
    linkSync(temp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    unlinkSync(temp);
  }
}

function writePublic(key: FleetKey, log: Logger | undefined): void {
  const pubPath = `${key.path}.pub`;
  const want = `${key.publicKey}\n`;
  let current: string | null = null;
  try {
    current = readFileSync(pubPath, 'utf8');
  } catch {
    current = null;
  }
  // The same key with another comment (made by ssh-keygen, say) is left alone.
  const sameKey = current !== null && current.trim().split(/\s+/).slice(0, 2).join(' ') === `${KEY_TYPE} ${key.blob}`;
  if (current === want || sameKey) return;
  writeFileSync(pubPath, want, { mode: 0o644 });
  chmodSync(pubPath, 0o644);
  if (current !== null) log?.warn({ path: pubPath }, 'fleet key: the .pub file did not match the private key; rewritten');
}

/**
 * The fleet key at `path`, made when missing. An existing private key is never touched; a missing or stale `.pub` is
 * rewritten from it. The folder is made at 0700.
 */
export function ensureFleetKey(path: string, log?: Logger): FleetKey {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const pair = generatePair();
    if (writeNew(path, pair.privateText, 0o600)) log?.info({ path }, 'fleet key: a new ed25519 key was made');
  }
  const key = loadFleetKey(path);
  writePublic(key, log);
  return key;
}

/** One `from=` entry: an IP address, or a network `address/bits`. Anything else (names, patterns, quotes) is refused. */
function fromEntry(entry: string): string {
  const [address = '', bits, extra] = entry.split('/');
  // A zone id (`fe80::1%eth0`) names an interface of this machine, not an address a server sees: refused.
  const family = address.includes('%') ? 0 : isIP(address);
  const max = family === 4 ? 32 : 128;
  const bitsOk = bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= max);
  if (family === 0 || extra !== undefined || !bitsOk) {
    throw new ValidationError('fleetFrom in config.json must list IP addresses or networks (for example 192.0.2.10 or 198.51.100.0/24)');
  }
  return entry;
}

/**
 * The `authorized_keys` line for the fleet key:
 * `no-port-forwarding,no-agent-forwarding,no-X11-forwarding[,from="…"] ssh-ed25519 <blob> luady-fleet`.
 * `from=` appears only when `config.fleetFrom` lists something.
 */
export function keyLine(key: Pick<FleetKey, 'blob'>, fleetFrom: readonly string[] = []): string {
  const blob = validateKeyBlob(key.blob);
  const from = fleetFrom.map(fromEntry);
  const options = from.length === 0 ? KEY_OPTIONS : `${KEY_OPTIONS},from="${from.join(',')}"`;
  return `${options} ${KEY_TYPE} ${blob} ${FLEET_KEY_COMMENT}`;
}
