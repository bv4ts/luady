import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import type { AuthContext, Connection, ParsedKey, PseudoTtyInfo, ServerChannel, Session } from 'ssh2';
import { fingerprintSha256 } from '../../src/fleet/host-key.js';

export interface ExecCall {
  command: string;
  stdin: Buffer;
}

export type ExecHandler = (call: ExecCall, channel: ServerChannel) => void;

export interface SshFixture {
  readonly port: number;
  readonly hostKeyFp: string;
  readonly clientKeyPath: string;
  readonly execs: ExecCall[];
  readonly ptys: PseudoTtyInfo[];
  readonly windowChanges: Array<{ cols: number; rows: number }>;
  readonly authAttempts: number;
  /** Client connections the server still holds open. */
  readonly openConnections: number;
  setExecHandler(handler: ExecHandler): void;
  dropConnections(): void;
  close(): Promise<void>;
}

const okHandler: ExecHandler = (_call, channel) => {
  channel.write('{"ok":true}');
  channel.exit(0);
  channel.end();
};

function parsePublicKey(text: string): ParsedKey {
  const parsed = ssh2.utils.parseKey(text);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const KEYGEN_ATTEMPTS = 20;

/**
 * ssh2 1.17 occasionally returns an unparseable ed25519 pair (a leading zero byte is dropped from the
 * key blob, about 1 call in 170). Retry until both halves parse.
 */
function generateEd25519(): { public: string; private: string } {
  for (let attempt = 0; attempt < KEYGEN_ATTEMPTS; attempt += 1) {
    const pair = ssh2.utils.generateKeyPairSync('ed25519');
    const publicKey = ssh2.utils.parseKey(pair.public);
    const privateKey = ssh2.utils.parseKey(pair.private);
    if (!(publicKey instanceof Error) && !(privateKey instanceof Error)) return pair;
  }
  throw new Error(`ssh2 produced no parseable ed25519 key pair in ${KEYGEN_ATTEMPTS} attempts`);
}

/** Echo shell: greets with "ready", echoes input, exits 0 on "exit". */
function echoShell(channel: ServerChannel): void {
  channel.write('ready\r\n');
  channel.on('data', (chunk: Buffer) => {
    if (chunk.toString('utf8') === 'exit') {
      channel.exit(0);
      channel.end();
      return;
    }
    channel.write(chunk);
  });
}

/** In-process ssh2 server with a fresh ed25519 host key and one authorized client key. */
export async function startSshFixture(): Promise<SshFixture> {
  const hostKey = generateEd25519();
  const clientKey = generateEd25519();
  const allowed = parsePublicKey(clientKey.public);
  const clientKeyPath = join(mkdtempSync(join(tmpdir(), 'luady-ssh-')), 'id_ed25519');
  writeFileSync(clientKeyPath, clientKey.private, { mode: 0o600 });

  const execs: ExecCall[] = [];
  const ptys: PseudoTtyInfo[] = [];
  const windowChanges: Array<{ cols: number; rows: number }> = [];
  const clients = new Set<Connection>();
  let handler: ExecHandler = okHandler;
  let authAttempts = 0;

  function authenticate(ctx: AuthContext): void {
    authAttempts += 1;
    if (ctx.method !== 'publickey' || !ctx.key.data.equals(allowed.getPublicSSH())) {
      ctx.reject(['publickey']);
      return;
    }
    if (ctx.signature === undefined || ctx.blob === undefined) {
      ctx.accept();
      return;
    }
    if (allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) ctx.accept();
    else ctx.reject(['publickey']);
  }

  function onSession(session: Session): void {
    session.on('pty', (accept, _reject, info) => {
      ptys.push(info);
      accept?.();
    });
    session.on('window-change', (accept, _reject, info) => {
      windowChanges.push({ cols: info.cols, rows: info.rows });
      accept?.();
    });
    session.on('shell', (accept) => echoShell(accept()));
    session.on('exec', (accept, _reject, info) => {
      const channel = accept();
      if (info.command.startsWith('tmux attach')) {
        execs.push({ command: info.command, stdin: Buffer.alloc(0) });
        echoShell(channel);
        return;
      }
      const chunks: Buffer[] = [];
      channel.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      channel.on('end', () => {
        const call = { command: info.command, stdin: Buffer.concat(chunks) };
        execs.push(call);
        handler(call, channel);
      });
    });
  }

  const server = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => clients.delete(client));
    client.on('authentication', authenticate);
    client.on('ready', () => client.on('session', (accept) => onSession(accept())));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    hostKeyFp: fingerprintSha256(parsePublicKey(hostKey.public).getPublicSSH()),
    clientKeyPath,
    execs,
    ptys,
    windowChanges,
    get authAttempts() {
      return authAttempts;
    },
    get openConnections() {
      return clients.size;
    },
    setExecHandler(next) {
      handler = next;
    },
    dropConnections() {
      for (const client of [...clients]) client.end();
    },
    close() {
      for (const client of [...clients]) client.end();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
