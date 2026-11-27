import { Socket } from 'node:net';
import ssh2 from 'ssh2';
import { HostReachError } from '../hosts/errors.js';
import { fingerprintSha256, keyTypeOf } from './host-key.js';

/**
 * Trust on first use, done by hand: connect, take the host key the server shows, and refuse it, so
 * the handshake ends before any user-auth request is ever sent. The owner compares the fingerprint with what the
 * server itself prints, then pins it. The caller passes an address already resolved and checked (hosts/resolve.ts).
 */
export const SCAN_TIMEOUT_MS = 10_000;

/** ssh2's own default order (ed25519 first): the pinned connection later negotiates the same host key. */
const HOST_KEY_ORDER = [
  'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa',
] as const;

export interface ScanTarget {
  /** A checked address (never a name: the caller resolved it). */
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
}

export interface ScanResult {
  readonly fingerprint: string;
  readonly keyType: string;
}

/** What the owner runs on the server to see the same fingerprint. */
export function compareCommand(keyType: string): string {
  const file = keyType === 'ssh-ed25519' ? 'ed25519' : keyType.startsWith('ecdsa-') ? 'ecdsa' : 'rsa';
  return `ssh-keygen -lf /etc/ssh/ssh_host_${file}_key.pub`;
}

/** The server's host key, or `unreachable` (no TCP connection) / `no_ssh` (something answered, but no SSH key). */
export function scanHostKey(target: ScanTarget): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    const client = new ssh2.Client();
    let connected = false;
    let seen: Buffer | null = null;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      client.end();
      sock.destroy();
      if (seen !== null) resolve({ fingerprint: fingerprintSha256(seen), keyType: keyTypeOf(seen) });
      else if (connected) reject(new HostReachError('no_ssh', 'No SSH server answered on that port'));
      else reject(new HostReachError('unreachable', 'The server could not be reached'));
    };
    sock.once('connect', () => {
      connected = true;
    });
    sock.on('error', () => finish());
    client.on('error', () => finish());
    client.on('close', () => finish());
    sock.connect(target.port, target.host);
    client.connect({
      sock,
      username: 'luady-scan',
      readyTimeout: target.timeoutMs ?? SCAN_TIMEOUT_MS,
      algorithms: { serverHostKey: [...HOST_KEY_ORDER] },
      hostVerifier: (key: Buffer): boolean => {
        seen = Buffer.from(key);
        // Refusing ends the key exchange: no user-auth request is ever sent.
        setImmediate(finish);
        return false;
      },
    });
  });
}
