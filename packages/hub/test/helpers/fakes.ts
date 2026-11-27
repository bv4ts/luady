import { pino } from 'pino';
import { SELF_HOST_ID, type CtlConfig } from '@luady/shared';
import { createHostLookups, type HostLookups } from '../../src/fleet/host-lookups.js';
import type {
  Clock,
  CtlClient,
  Logger,
  OutboundChannel,
  OutboundLink,
  PhoneService,
} from '../../src/core/contracts.js';

type CallLog = Array<{ method: string; args: unknown[] }>;
type SentLog = Array<{ text: string; link: OutboundLink | null; quotedId: string | null }>;

const DEFAULT_CLOCK_START = '2026-10-09T12:00:00.000Z';
const DEFAULT_CTL_CONFIG: CtlConfig = { remote_answering: true, hook_wait_seconds: 14400, host_alias: 'cedar' };

/** CtlClient whose methods resolve minimal valid ctl objects. Every call, overridden or not, lands in `calls`. */
export function createFakeCtl(over: Partial<CtlClient> = {}): CtlClient & { calls: CallLog } {
  const calls: CallLog = [];
  const impl: CtlClient = { ...defaultCtl(), ...over };
  const rec = recorder(calls);
  return {
    calls,
    version: rec('version', impl.version),
    sysinfo: rec('sysinfo', impl.sysinfo),
    sessions: rec('sessions', impl.sessions),
    pending: rec('pending', impl.pending),
    answer: rec('answer', impl.answer),
    permission: rec('permission', impl.permission),
    send: rec('send', impl.send),
    keys: rec('keys', impl.keys),
    start: rec('start', impl.start),
    stop: rec('stop', impl.stop),
    restart: rec('restart', impl.restart),
    remove: rec('remove', impl.remove),
    transcript: rec('transcript', impl.transcript),
    capture: rec('capture', impl.capture),
    updateClaude: rec('updateClaude', impl.updateClaude),
    projects: rec('projects', impl.projects),
    exec: rec('exec', impl.exec),
    fileRead: rec('fileRead', impl.fileRead),
    fileGet: rec('fileGet', impl.fileGet),
    filePut: rec('filePut', impl.filePut),
    graphifyRun: rec('graphifyRun', impl.graphifyRun),
    graphQuery: rec('graphQuery', impl.graphQuery),
    fileWrite: rec('fileWrite', impl.fileWrite),
    getConfig: rec('getConfig', impl.getConfig),
    setConfig: rec('setConfig', impl.setConfig),
    authStatus: rec('authStatus', impl.authStatus),
    authLogin: rec('authLogin', impl.authLogin),
    authCode: rec('authCode', impl.authCode),
    authLogout: rec('authLogout', impl.authLogout),
    pause: rec('pause', impl.pause),
    resume: rec('resume', impl.resume),
    skills: rec('skills', impl.skills),
    kbPut: rec('kbPut', impl.kbPut),
    gitStatus: rec('gitStatus', impl.gitStatus),
  };
}

/** Records every send (text unsplit). Returns `fake-wa-<n>` while `up`, `null` ("queued") while down. */
export interface FakeOutbound extends OutboundChannel {
  sent: SentLog;
  up: boolean;
  typed: boolean[];
  played: string[];
  edits: Array<{ msgId: string; text: string }>;
  pins: Array<{ msgId: string; on: boolean }>;
  revokes: string[];
  /** The adapter refuses every send (sendChecked reports it). */
  refuse: boolean;
  sendChecked: NonNullable<OutboundChannel['sendChecked']>;
}

export function createFakeOutbound(): FakeOutbound {
  let delivered = 0;
  const fake: FakeOutbound = {
    sent: [],
    typed: [],
    played: [],
    edits: [],
    pins: [],
    revokes: [],
    up: true,
    refuse: false,
    sendChecked: async (text, link, quotedId = null) => {
      fake.sent.push({ text, link, quotedId });
      if (fake.refuse) return { msgId: null, refused: true };
      if (!fake.up) return { msgId: null, refused: false };
      delivered += 1;
      return { msgId: `fake-wa-${delivered}`, refused: false };
    },
    markPlayed: (msgId) => {
      fake.played.push(msgId);
    },
    typing: (on) => {
      fake.typed.push(on);
    },
    edit: async (msgId, text) => {
      fake.edits.push({ msgId, text });
      return fake.up;
    },
    pin: (msgId, on) => {
      fake.pins.push({ msgId, on });
    },
    revoke: (msgId) => {
      fake.revokes.push(msgId);
    },
    isUp: () => fake.up,
    send: async (text, link, quotedId = null) => {
      fake.sent.push({ text, link, quotedId });
      if (!fake.up) {
        return null;
      }
      delivered += 1;
      return `fake-wa-${delivered}`;
    },
  };
  return fake;
}

/** Deterministic clock; default start 2026-10-09T12:00:00.000Z. now() hands out a fresh Date each call. */
export function createFakeClock(
  startIso: string = DEFAULT_CLOCK_START,
): Clock & { advance(ms: number): void; set(iso: string): void } {
  let currentMs = parseIsoMs(startIso);
  return {
    now: () => new Date(currentMs),
    advance: (ms: number) => {
      if (!Number.isFinite(ms)) {
        throw new RangeError(`advance(ms) needs a finite number, got ${ms}`);
      }
      currentMs += ms;
    },
    set: (iso: string) => {
      currentMs = parseIsoMs(iso);
    },
  };
}

/** pino at level 'silent': satisfies Logger and prints nothing. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/** PhoneService that is never enabled; records `question:<qid>` and `owner:<reason>` in `calls`. */
export function createNullPhone(): PhoneService & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    enabled: () => false,
    callForQuestion: async (qid: string) => {
      calls.push(`question:${qid}`);
    },
    callOwner: async (reason: string) => {
      calls.push(`owner:${reason}`);
    },
  };
}

function recorder(calls: CallLog) {
  return <A extends unknown[], R>(method: string, fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      calls.push({ method, args: [...args] });
      try {
        return fn(...args);
      } catch (err) {
        return Promise.reject(err);
      }
    };
}

function parseIsoMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`Not an ISO-8601 timestamp: ${iso}`);
  }
  return ms;
}

function defaultCtl(): CtlClient {
  return {
    version: async () => ({ kit: '1.0.0', claude: '2.1.295', tmux: '3.4', python: '3.12.3' }),
    sysinfo: async () => ({
      load1: 0.12,
      load5: 0.2,
      mem_total_kb: 8_000_000,
      mem_avail_kb: 4_000_000,
      disk_free_kb: 6_000_000,
      uptime_s: 86_400,
    }),
    sessions: async () => ({ sessions: [] }),
    pending: async () => ({ pending: [] }),
    answer: async () => undefined,
    permission: async () => undefined,
    send: async () => undefined,
    keys: async () => undefined,
    start: async (args) => ({ ok: true, target: `cc-${args.name}:0.0` }),
    stop: async (_target, force) => ({ ok: true, forced: force }),
    restart: async () => undefined,
    remove: async (sessionId) => ({ ok: true, trashed: `/home/dev/.luady/trash/20261009T120000Z-${sessionId}.jsonl` }),
    transcript: async (sessionId) => ({
      path: `/home/dev/.claude/projects/-home-dev-projects-demo/${sessionId}.jsonl`,
      size: 0,
      from: 0,
      to: 0,
      data: '',
    }),
    capture: async () => '',
    updateClaude: async () => ({ before: '2.1.295', after: '2.1.295', output: '' }),
    projects: async () => ({ projects: [] }),
    exec: async () => ({ exit: 0, stdout: '', stderr: '', truncated: false, timed_out: false }),
    fileRead: async (path) => ({ path, size: 0, content: '', truncated: false }),
    fileGet: async (path) => ({ path, size: 1, b64: 'AA==' }),
    filePut: async (name, b64) => ({ path: `/home/dev/luady-inbox/${name}`, size: Math.floor((b64.length * 3) / 4) }),
    graphifyRun: async (path) => ({ path, seconds: 1, report: '# Graph Report\n', tail: '' }),
    graphQuery: async (path) => ({ path, built_at: '2026-10-10 02:00', text: '' }),
    fileWrite: async (_path, content) => ({ ok: true, bytes: Buffer.byteLength(content, 'utf8') }),
    getConfig: async () => ({ ...DEFAULT_CTL_CONFIG }),
    setConfig: async (key, value) => ({ ...DEFAULT_CTL_CONFIG, ...configValue(key, value) }),
    authStatus: async () => ({
      logged_in: true, email: 'owner@example.com', expires_at: '2026-12-01T00:00:00.000Z', org_id: 'org_test', org_name: 'Test Org', plan: 'max',
    }),
    authLogin: async () => ({ url: 'https://claude.com/cai/oauth/authorize?code=true&state=s1' }),
    authCode: async () => ({ ok: true, message: 'Login successful', logged_in: true, email: 'owner@example.com', expires_at: '2026-12-01T00:00:00.000Z' }),
    authLogout: async () => ({ ok: true, message: 'Signed out', logged_in: false, email: null, expires_at: null }),
    pause: async () => ({ ok: true, paused: true }),
    resume: async () => ({ ok: true, was_hit: true, sent: true }),
    skills: async () => ({ skills: [] }),
    kbPut: async (files) => ({ written: files.length, removed: 0 }),
    gitStatus: async () => ({ projects: [] }),
  };
}

function configValue(key: 'remote_answering' | 'hook_wait_seconds', value: string): Partial<CtlConfig> {
  return key === 'remote_answering'
    ? { remote_answering: value === 'true' }
    : { hook_wait_seconds: Number.parseInt(value, 10) };
}

/** The demo servers the hub's tests use: plain fixture ids, nothing in the code knows them. */
export const DEMO_SERVERS = ['cedar', 'birch', 'ash', 'local'] as const;
/** The demo servers plus the self host. */
export const DEMO_HOSTS = [...DEMO_SERVERS, SELF_HOST_ID] as const;

/** A fake fleet's host lookups over the demo servers (plus the self host), each with the demo user's folders. */
export function classicHostLookups(): HostLookups {
  return createHostLookups(() => DEMO_SERVERS.map((name) => ({ name, projectsRoot: '/home/dev/projects', homeDir: '/home/dev' })));
}
