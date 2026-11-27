import { createServer, type AddressInfo, type Server } from 'node:net';
import ssh2 from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { fingerprintSha256, keyTypeOf } from '../../src/fleet/host-key.js';
import { compareCommand, scanHostKey } from '../../src/fleet/host-scan.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((run) => run()));
});

function pair(type: 'ed25519' | 'ecdsa'): { private: string; public: string } {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const made = type === 'ed25519' ? ssh2.utils.generateKeyPairSync('ed25519') : ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 });
    if (!(ssh2.utils.parseKey(made.public) instanceof Error) && !(ssh2.utils.parseKey(made.private) instanceof Error)) return made;
  }
  throw new Error('no parseable key pair');
}

function fingerprintOf(publicText: string): string {
  const parsed = ssh2.utils.parseKey(publicText);
  if (parsed instanceof Error) throw parsed;
  return fingerprintSha256(parsed.getPublicSSH());
}

/** An in-process SSH server holding the given host keys; it counts every user-auth request it receives. */
async function sshServer(hostKeys: string[]): Promise<{ port: number; auths: () => number }> {
  let auths = 0;
  const server = new ssh2.Server({ hostKeys }, (client) => {
    client.on('authentication', (ctx) => {
      auths += 1;
      ctx.reject();
    });
    client.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, auths: () => auths };
}

async function tcpServer(onSocket: (socket: import('node:net').Socket) => void): Promise<number> {
  const open = new Set<import('node:net').Socket>();
  const server: Server = createServer((socket) => {
    open.add(socket);
    socket.on('error', () => undefined);
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const socket of open) socket.destroy();
    server.close(() => resolve());
  }));
  return (server.address() as AddressInfo).port;
}

describe('scanning a host key: no authentication is ever attempted', () => {
  it('returns the fingerprint and key type of the server\'s ed25519 key, and no userauth request arrives', async () => {
    const ed = pair('ed25519');
    const server = await sshServer([ed.private]);
    const result = await scanHostKey({ host: '127.0.0.1', port: server.port });
    expect(result).toEqual({ fingerprint: fingerprintOf(ed.public), keyType: 'ssh-ed25519' });
    expect(server.auths()).toBe(0);
  });

  it('prefers ed25519 when the server offers several keys', async () => {
    const ec = pair('ecdsa');
    const ed = pair('ed25519');
    const server = await sshServer([ec.private, ed.private]);
    const result = await scanHostKey({ host: '127.0.0.1', port: server.port });
    expect(result.keyType).toBe('ssh-ed25519');
    expect(result.fingerprint).toBe(fingerprintOf(ed.public));
  });

  it('falls back to the key the server has, with the matching compare command', async () => {
    const ec = pair('ecdsa');
    const server = await sshServer([ec.private]);
    const result = await scanHostKey({ host: '127.0.0.1', port: server.port });
    expect(result.keyType).toBe('ecdsa-sha2-nistp256');
    expect(compareCommand(result.keyType)).toBe('ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub');
    expect(compareCommand('ssh-ed25519')).toBe('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
    expect(compareCommand('ssh-rsa')).toBe('ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub');
  });

  it('says only unreachable for a closed port, and no-ssh for something that is not an SSH server', async () => {
    const closedPort = await tcpServer(() => undefined);
    await cleanups.pop()?.();
    await expect(scanHostKey({ host: '127.0.0.1', port: closedPort, timeoutMs: 2000 })).rejects.toMatchObject({ code: 'unreachable' });
    const web = await tcpServer((socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    await expect(scanHostKey({ host: '127.0.0.1', port: web, timeoutMs: 2000 })).rejects.toMatchObject({ code: 'no_ssh' });
    const silent = await tcpServer(() => undefined);
    await expect(scanHostKey({ host: '127.0.0.1', port: silent, timeoutMs: 300 })).rejects.toMatchObject({ code: 'no_ssh' });
  });

  it('reads the key type from a blob', () => {
    const ed = ssh2.utils.parseKey(pair('ed25519').public);
    if (ed instanceof Error) throw ed;
    expect(keyTypeOf(ed.getPublicSSH())).toBe('ssh-ed25519');
    expect(keyTypeOf(Buffer.from([0, 0, 0, 99]))).toBe('unknown');
  });
});
