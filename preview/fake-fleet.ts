import { SELF_HOST_ID, isSelfHost, type CtlSysinfo, type HostId, type ServerDTO } from '@luady/shared';
import type { EventBus, ShellStream } from '../packages/hub/dist/core/contracts.js';
import type { RemoteExecutor } from '../packages/hub/dist/fleet/executor.js';
import type { DynamicFleet } from '../packages/hub/dist/fleet/fleet-core.js';
import { createHostLookups, type KnownHost } from '../packages/hub/dist/fleet/host-lookups.js';
import type { HostRecord } from '../packages/hub/dist/fleet/servers-repo.js';
import { PREVIEW_PROJECTS_ROOT, PREVIEW_SERVERS, previewHost } from './config.ts';
import { createFakeKit, KIT_VERSION, type FakeKit } from './fake-kit.ts';

/**
 * The fleet the hub sees in the preview: one fake kit per host, no SSH, no terminals. It is a dynamic fleet (the hosts
 * module adds, replaces and removes hosts while the hub runs): a host the owner adds and pins on the website gets a
 * fake kit and a fake link that is online at once.
 */
/** The hosts the preview starts with: its four servers and the manager's own. */
export const PREVIEW_HOSTS: readonly HostId[] = Object.freeze([...PREVIEW_SERVERS, SELF_HOST_ID]);

export interface PreviewFleet extends DynamicFleet {
  kit(host: HostId): FakeKit;
  /** Every host with a fake kit: the seeded ones and each host added since, in that order. */
  kitHosts(): readonly HostId[];
  /** Emits bus `server.updated` once a bus is bound. */
  setStatus(server: HostId, status: ServerDTO['status']): void;
  bindBus(bus: EventBus): void;
}

export interface PreviewFleetDeps {
  clock: () => Date;
  /** The hosts table's row for an id (the hub's servers repo); the fleet reads it when a host is added or replaced. */
  records?: (id: string) => HostRecord | undefined;
}

const MEM_TOTAL_KB = 8_000_000;
const UPTIME_S = 900_000;

const DISK_TOTAL_KB = 120_000_000;

/**
 * Kit 2.1 reports the disk's size; `local` runs an install from before that, so its disk shows as unknown (the fleet
 * wall's "older kit" case).
 */
const sysinfo = (load1: number, load5: number, memAvailKb: number, diskFreeKb: number, diskSize = true): CtlSysinfo => ({
  load1, load5, mem_total_kb: MEM_TOTAL_KB, mem_avail_kb: memAvailKb, disk_free_kb: diskFreeKb, uptime_s: UPTIME_S,
  ...(diskSize ? { disk_total_kb: DISK_TOTAL_KB } : {}),
});

/** birch has little memory left and ash little disk, so the warning styles have something to show. */
export const PREVIEW_SYSINFO: Readonly<Record<HostId, CtlSysinfo>> = {
  cedar: sysinfo(0.6, 0.5, 5_200_000, 60_000_000),
  birch: sysinfo(3.4, 3.1, 1_000_000, 22_000_000),
  ash: sysinfo(1.2, 1.0, 4_100_000, 6_000_000),
  local: sysinfo(0.2, 0.2, 6_000_000, 40_000_000, false),
  [SELF_HOST_ID]: sysinfo(0.2, 0.2, 6_000_000, 40_000_000),
};
/** A server the owner adds in the demo: quiet, with room to spare. */
const ADDED_SYSINFO = sysinfo(0.3, 0.3, 6_500_000, 90_000_000);
const ADDED_PHASE = 2.6;

const DAY_S = 86_400;
const PHASE: Readonly<Record<HostId, number>> = { cedar: 0.4, birch: 1.9, ash: 3.1, local: 4.4, [SELF_HOST_ID]: 5.2 };
const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * The numbers a server reports at a moment: its base values moving with the working day and a shorter ripple, so the
 * fleet wall's 24-hour graphs have a shape. Deterministic (no random numbers). A host added in the demo has its own.
 */
export function sysinfoAt(host: HostId, at: Date): CtlSysinfo {
  const base = PREVIEW_SYSINFO[host] ?? ADDED_SYSINFO;
  const phase = PHASE[host] ?? ADDED_PHASE;
  const t = at.getTime() / 1000;
  const day = Math.sin((2 * Math.PI * t) / DAY_S + phase);
  const ripple = Math.sin((2 * Math.PI * t) / 5_400 + 3 * phase);
  const load = Math.max(0.05, base.load1 * (1 + 0.45 * day + 0.15 * ripple));
  const avail = Math.min(base.mem_total_kb, Math.max(200_000, base.mem_avail_kb * (1 - 0.25 * day - 0.06 * ripple)));
  const disk = Math.max(500_000, base.disk_free_kb * (1 - 0.03 * (((t % DAY_S) + DAY_S) % DAY_S) / DAY_S));
  return { ...base, load1: round2(load), load5: round2(load * 0.9), mem_avail_kb: Math.round(avail), disk_free_kb: Math.round(disk) };
}

interface Link { readonly status: ServerDTO['status']; readonly lastSeenAt: string | null }
/** A host the owner added while the preview runs, as its row says. */
interface AddedHost { readonly kind: 'ssh' | 'local'; readonly host: string; readonly projectsRoot: string | null; readonly homeDir: string | null }

const NO_TERMINALS = 'The preview has no terminals';
/** The hosts the preview starts with: their fake kits stay, whatever happens to their rows. */
const SEEDED: ReadonlySet<string> = new Set<string>(PREVIEW_HOSTS);

/** A link that is up, runs nothing and never touches the network: what the hosts module waits on and checks. */
function demoExecutor(): RemoteExecutor & { lastError(): null; resume(): void } {
  return {
    start: () => undefined,
    status: () => 'online',
    onStatus: () => () => undefined,
    shell: async (): Promise<ShellStream> => {
      throw new Error(NO_TERMINALS);
    },
    exec: async () => {
      throw new Error('The preview runs no command on a server');
    },
    execStream: () => ({ stop: () => undefined, done: Promise.resolve() }),
    close: async () => undefined,
    lastError: () => null,
    resume: () => undefined,
  };
}

function addedFrom(record: HostRecord): AddedHost {
  return { kind: record.kind, host: record.host, projectsRoot: record.projectsRoot, homeDir: record.homeDir };
}

export function createPreviewFleet(deps: PreviewFleetDeps): PreviewFleet {
  const kits = new Map<HostId, FakeKit>(
    PREVIEW_HOSTS.map((host) => [host, createFakeKit(host, { clock: deps.clock, sysinfo: PREVIEW_SYSINFO[host] ?? ADDED_SYSINFO })]),
  );
  const added = new Map<string, AddedHost>();
  const links = new Map<string, Link>(PREVIEW_SERVERS.map((name) => [name, { status: 'online', lastSeenAt: null }]));
  const executors = new Map<string, RemoteExecutor>();
  let bus: EventBus | null = null;

  const kit = (host: HostId): FakeKit => {
    const found = kits.get(host);
    if (found === undefined) throw new Error(`unknown host ${String(host)}`);
    return found;
  };

  const linkOf = (name: HostId): Link => {
    const link = links.get(name);
    if (link === undefined) throw new Error(`unknown server ${name}`);
    return link;
  };

  /** An online server was seen just now; an offline one when it went away. */
  const dto = (name: HostId): ServerDTO => {
    const link = linkOf(name);
    const extra = added.get(name);
    return {
      name, host: extra?.host ?? previewHost(name), status: link.status,
      lastSeenAt: link.status === 'online' ? deps.clock().toISOString() : link.lastSeenAt,
      claudeVersion: KIT_VERSION.claude, kitVersion: KIT_VERSION.kit, sysinfo: sysinfoAt(name, deps.clock()),
      kind: extra?.kind ?? 'ssh', projectsRoot: extra?.projectsRoot ?? null, homeDir: extra?.homeDir ?? null, terminal: extra?.kind !== 'local',
    };
  };

  const names = (): string[] => [...PREVIEW_SERVERS, ...added.keys()];
  const known = (): KnownHost[] => [
    // The demo servers' own projects folder, where the fake manager starts its sessions.
    ...PREVIEW_SERVERS.map((name) => ({ name, projectsRoot: PREVIEW_PROJECTS_ROOT })),
    ...[...added].map(([name, host]) => ({ name, kind: host.kind, projectsRoot: host.projectsRoot, homeDir: host.homeDir })),
  ];
  const hasLink = (id: string): boolean => !isSelfHost(id) && links.has(id);

  /** The row the hosts module wrote; only a pinned one gets a link. */
  const pinnedRecord = (id: string): HostRecord => {
    const record = deps.records?.(id);
    if (record === undefined || record.state !== 'pinned') throw new Error(`${id} is not a pinned host`);
    return record;
  };

  return {
    kit,
    kitHosts: () => [...kits.keys()],
    client: (host) => kit(host).client,
    servers: () => names().map(dto),
    setStatus(server, status) {
      const link = linkOf(server);
      const lastSeenAt = link.status === 'online' ? deps.clock().toISOString() : link.lastSeenAt;
      links.set(server, { status, lastSeenAt });
      bus?.emit('server.updated', dto(server));
    },
    bindBus(next) {
      bus = next;
    },
    start: async () => undefined,
    stop: async () => undefined,
    openShell: async (): Promise<ShellStream> => {
      throw new Error(NO_TERMINALS);
    },
    // Host lookups over the preview's servers and the ones added since (the hub's own helper, the one its own fleet uses).
    ...createHostLookups(known),
    tailEvents(host, _from, onLine) {
      let stopped = false;
      let finish: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      kit(host).attach((line) => {
        if (!stopped) onLine(line);
      });
      return {
        stop() {
          stopped = true;
          finish();
        },
        done,
      };
    },
    addHost(id) {
      if (isSelfHost(id) || links.has(id)) throw new Error(`${id} already has a link`);
      const record = pinnedRecord(id);
      added.set(id, addedFrom(record));
      kits.set(id, createFakeKit(id, { clock: deps.clock, sysinfo: ADDED_SYSINFO }));
      links.set(id, { status: 'online', lastSeenAt: null });
      bus?.emit('server.updated', dto(id));
    },
    async replaceHost(id) {
      if (!hasLink(id)) throw new Error(`${id} has no link`);
      const record = deps.records?.(id);
      if (added.has(id) && record !== undefined) added.set(id, addedFrom(record));
      executors.delete(id);
      bus?.emit('server.updated', dto(id));
    },
    async removeHost(id) {
      added.delete(id);
      executors.delete(id);
      links.delete(id);
      if (!SEEDED.has(id)) kits.delete(id);
    },
    link: (id) => (hasLink(id) ? linkOf(id).status : null),
    executor(id) {
      if (!hasLink(id)) return undefined;
      const existing = executors.get(id);
      if (existing !== undefined) return existing;
      const made = demoExecutor();
      executors.set(id, made);
      return made;
    },
    lastSync: () => null,
  };
}
