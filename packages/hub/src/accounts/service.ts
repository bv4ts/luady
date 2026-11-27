import {
  KIT_V2, SELF_HOST_ID, isSelfHost, managerName, versionAtLeast, type AccountDTO, type AccountsDTO, type ChannelInfoDTO, type ConnectionDTO,
  type ConnectService, type HostId, type JiraSiteDTO,
} from '@luady/shared';
import type { ClaudeLoginService } from '../claude-login/service.js';
import type { Clock, EventBus, Fleet, HubEvents, Logger } from '../core/contracts.js';
import type { CodexLogin } from '../media/codex-login.js';
import { UNKNOWN_LIMITS, groupAccounts } from './group.js';
import type { LimitsStore } from './limits.js';
import { limitsText } from './text.js';

/** Limits that move emit `accounts.changed` at most this often; a trailing emit carries the last change. */
export const ACCOUNTS_CHANGED_MIN_MS = 30_000;
/** What a Wispr Flow row says while it is not connected: the chat command works on any channel. */
export const wisprConnectHint = (): string => `Send /wispr to ${managerName()} to connect`;

export interface AccountsService {
  list(): Promise<AccountsDTO>;
  /** One line per Claude account, for Luady's `account_limits` tool. */
  limitsText(): Promise<string>;
  start(): void;
  stop(): void;
}

export interface AccountsDeps {
  bus: EventBus;
  clock: Clock;
  log: Logger;
  fleet: Pick<Fleet, 'servers'>;
  login: Pick<ClaudeLoginService, 'statuses' | 'pending'>;
  limits: LimitsStore;
  codex: Pick<CodexLogin, 'status' | 'onResult'>;
  /** A line for the Codex sign-in while it must be made again (media/codex.ts codexSignInMoved), else null. */
  codexNote?: () => string | null;
  google: { accounts(): Array<{ email: string; label: string }> } | null;
  imapLabel: string | null;
  wisprConnected: () => boolean;
  /** The offices with Jira connected (one connection row each). */
  jiraSites?: () => readonly JiraSiteDTO[];
  /** The declared channels, read at call time; one connection row each. */
  channels?: () => readonly ChannelInfoDTO[];
  /** The name the owner knows for a room id (rooms/): the Jira rows are per room. Absent: the id itself. */
  officeName?: (room: string) => string;
  /** Where the website starts connecting Google or Wispr; null (or absent) when it cannot link there. */
  connectUrl?: (service: ConnectService) => string | null;
}

const CODEX_LOGGED_IN = { in: true, out: false, unknown: null } as const;

function connection(id: ConnectionDTO['id'], label: string, state: ConnectionDTO['state'], detail: string | null, connectUrl: string | null = null): ConnectionDTO {
  return { id, label, state, detail, connectUrl };
}

/** One row per declared channel: up is connected, a channel whose add-on never came is unavailable. */
function channelConnection(channel: ChannelInfoDTO): ConnectionDTO {
  if (channel.state === 'up') return connection(channel.id, channel.name, 'connected', channel.detail);
  if (channel.state === 'absent') return connection(channel.id, channel.name, 'unavailable', channel.detail);
  return connection(channel.id, channel.name, 'not_connected', channel.detail ?? channel.state);
}

/** One row per connected office: the site and account, or the last error in plain words. */
function jiraConnection(site: JiraSiteDTO, officeName: (room: string) => string): ConnectionDTO {
  const who = site.displayName ?? site.email;
  return connection('jira', `Jira · ${officeName(site.server)}`, 'connected', site.lastError ?? `${new URL(site.baseUrl).host} as ${who}`);
}

function connections(deps: AccountsDeps): ConnectionDTO[] {
  const google = deps.google?.accounts() ?? null;
  const connectUrl = (service: ConnectService): string | null => deps.connectUrl?.(service) ?? null;
  const officeName = (room: string): string => deps.officeName?.(room) ?? room;
  return [
    ...(deps.channels?.() ?? []).map(channelConnection),
    google === null
      ? connection('google', 'Gmail and Calendar', 'unavailable', null)
      : connection('google', 'Gmail and Calendar', google.length > 0 ? 'connected' : 'not_connected', google.length > 0 ? google.map((a) => a.label).join(', ') : null, connectUrl('google')),
    connection('imap', 'Mailbox', deps.imapLabel === null ? 'unavailable' : 'connected', deps.imapLabel),
    deps.wisprConnected()
      ? connection('wispr', 'Wispr Flow', 'connected', null)
      : connection('wispr', 'Wispr Flow', 'not_connected', wisprConnectHint(), connectUrl('wispr')),
    ...(deps.jiraSites?.() ?? []).map((site) => jiraConnection(site, officeName)),
  ];
}

function codexAccount(status: 'in' | 'out' | 'unknown', checkedAt: string, note: string | null): AccountDTO {
  return {
    ...(note === null || status === 'in' ? {} : { note }),
    id: 'codex', provider: 'codex', email: null, orgName: null, plan: 'ChatGPT', isManager: false, limits: UNKNOWN_LIMITS,
    hosts: [{ host: SELF_HOST_ID, loggedIn: CODEX_LOGGED_IN[status], expiresAt: null, checkedAt, loginPending: false, canLogout: true }],
  };
}

/** Groups hosts into accounts with their limits (fed by the kit's meter events), plus the Codex sign-in and the connections. */
export function createAccountsService(deps: AccountsDeps): AccountsService {
  let offs: ReadonlyArray<() => void> = [];
  let lastEmitMs: number | null = null;
  let trailing: ReturnType<typeof setTimeout> | null = null;

  const emit = (): void => {
    lastEmitMs = deps.clock.now().getTime();
    deps.bus.emit('accounts.changed', { at: deps.clock.now().toISOString() });
  };

  function limitsMoved(): void {
    if (trailing !== null) return;
    const since = lastEmitMs === null ? Infinity : deps.clock.now().getTime() - lastEmitMs;
    if (since >= ACCOUNTS_CHANGED_MIN_MS) {
      emit();
      return;
    }
    trailing = setTimeout(() => {
      trailing = null;
      emit();
    }, ACCOUNTS_CHANGED_MIN_MS - since);
  }

  function onMeters(event: HubEvents['meters.updated']): void {
    // A signed-out host belongs to no account: its reading is not merged anywhere.
    if (deps.login.statuses().find((status) => status.host === event.host)?.loggedIn === false) return;
    // Ordered by the hub's clock: a reading dated in the future (a server clock ahead) counts as now.
    const now = deps.clock.now().toISOString();
    const at = event.at > now ? now : event.at;
    try {
      if (deps.limits.record(event.host, { fiveHour: event.fiveHour, sevenDay: event.sevenDay }, at)) limitsMoved();
    } catch (err) {
      deps.log.warn({ host: event.host, err: err instanceof Error ? err.message : String(err) }, 'accounts: limits not stored');
    }
  }

  const kitOk = (host: HostId): boolean =>
    isSelfHost(host) || versionAtLeast(deps.fleet.servers().find((server) => server.name === host)?.kitVersion, KIT_V2);

  function claudeAccounts(): AccountDTO[] {
    const statuses = deps.login.statuses();
    const pending = statuses.map((status) => status.host).filter((host) => deps.login.pending(host) !== null);
    return groupAccounts({ statuses, limits: deps.limits.all(), pending, kitOk, now: deps.clock.now() });
  }

  return {
    async list() {
      const codex = await deps.codex.status();
      return { accounts: [...claudeAccounts(), codexAccount(codex, deps.clock.now().toISOString(), deps.codexNote?.() ?? null)], connections: connections(deps) };
    },
    async limitsText() {
      return limitsText(claudeAccounts(), deps.clock.now());
    },
    start() {
      if (offs.length > 0) return;
      offs = [deps.bus.on('meters.updated', onMeters), deps.codex.onResult(() => emit())];
    },
    stop() {
      for (const off of offs) off();
      offs = [];
      if (trailing !== null) clearTimeout(trailing);
      trailing = null;
    },
  };
}
