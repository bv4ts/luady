import type { HostId, ServerDTO } from '@luady/shared';
import type { CtlClient, Fleet, ShellStream } from '../../src/core/contracts.js';
import { DEMO_HOSTS, createFakeCtl, classicHostLookups } from '../helpers/fakes.js';

export interface FakeTail {
  readonly host: HostId;
  readonly from: string;
  emit(line: string): void;
  end(): void;
  readonly stopped: boolean;
}

export interface FakeFleet extends Fleet {
  readonly tails: FakeTail[];
  setServers(servers: readonly ServerDTO[]): void;
  setClient(host: HostId, client: CtlClient): void;
}

export function serverDto(name: HostId, status: ServerDTO['status'] = 'online'): ServerDTO {
  return {
    name, host: `${name}.example.net`, status, lastSeenAt: null, claudeVersion: null, kitVersion: null, sysinfo: null,
    kind: 'ssh', projectsRoot: null, homeDir: null, terminal: true,
  };
}

function fakeTail(host: HostId, from: string, onLine: (line: string) => void): { tail: FakeTail; stop(): void; done: Promise<void> } {
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let stopped = false;
  const tail: FakeTail = {
    host,
    from,
    emit(line) {
      if (!stopped) onLine(line);
    },
    end: () => finish(),
    get stopped() {
      return stopped;
    },
  };
  return {
    tail,
    stop() {
      stopped = true;
      finish();
    },
    done,
  };
}

/** In-memory Fleet: per-host fake CtlClients, settable server list, and controllable tail-events streams. */
export function createFakeFleet(initial: Partial<Record<HostId, CtlClient>> = {}): FakeFleet {
  const clients = new Map<HostId, CtlClient>();
  for (const host of DEMO_HOSTS) {
    const client = initial[host];
    if (client !== undefined) clients.set(host, client);
  }
  let servers: readonly ServerDTO[] = [];
  const tails: FakeTail[] = [];
  return {
    tails,
    setServers(next) {
      servers = next;
    },
    setClient(host, client) {
      clients.set(host, client);
    },
    async start() {
      return undefined;
    },
    async stop() {
      return undefined;
    },
    client(host) {
      const existing = clients.get(host);
      if (existing !== undefined) return existing;
      const created = createFakeCtl();
      clients.set(host, created);
      return created;
    },
    servers: () => [...servers],
    async openShell(): Promise<ShellStream> {
      throw new Error('openShell is not supported by the fake fleet');
    },
    ...classicHostLookups(),
    tailEvents(host, from, onLine) {
      const created = fakeTail(host, from, onLine);
      tails.push(created.tail);
      return { stop: created.stop, done: created.done };
    },
  };
}
