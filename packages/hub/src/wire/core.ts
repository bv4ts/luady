import { chmod, mkdir, rm } from 'node:fs/promises';
import { posix } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { setManagerName, setOwnerZone, type Settings } from '@luady/shared';
import { createBus } from '../core/bus.js';
import { systemClock } from '../core/clock.js';
import type { AccessVerifier, Clock, Db } from '../core/contracts.js';
import { openDb } from '../db/open.js';
import { createLogger } from '../log.js';
import { createNoticesRepo, NOTICE_RETENTION_DAYS } from '../notices/repo.js';
import { VOICE_PORT } from '../phone/server.js';
import { classifyCommand } from '../security/risk.js';
import { createSettingsService } from '../settings/service.js';
import { allowedHostsOf, authModeOf, bindHostOf, hubSocketPath, ownerLabelOf } from '../config/defaults.js';
import type { HubConfig } from '../core/contracts.js';
import { createAccessVerifier, createLocalIdentity } from '../web/auth/access.js';
import { createPageKeyCheck } from '../web/auth/page-key.js';
import { createSessionStore } from '../web/auth/sessions.js';
import { createHostCheck } from '../web/host-check.js';
import { createWebServer, type WebDeps } from '../web/server.js';
import type { WireContext, Wired } from './context.js';

/**
 * Core: config, database, bus, clock and log; settings; the access verifier; the web server, fed by
 * every module's `web` contribution; the retention and action sweeps; listening. Also the owner's zone and the
 * manager's name, applied at boot and on every settings change, and the listen address `config.bindHost`.
 */
const ACTION_SWEEP_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
const EVENTS_RETENTION_DAYS = 90;
const CHANNEL_SEEN_RETENTION_DAYS = 30;
const SOCKET_MODE = 0o600;
const RUN_DIR_MODE = 0o700;

function sweepRetention(db: Db, clock: Clock): void {
  const now = clock.now().getTime();
  db.prepare('DELETE FROM events WHERE ts < ?').run(new Date(now - EVENTS_RETENTION_DAYS * DAY_MS).toISOString());
  db.prepare('DELETE FROM channel_seen WHERE seen_at < ?').run(new Date(now - CHANNEL_SEEN_RETENTION_DAYS * DAY_MS).toISOString());
  db.prepare('DELETE FROM google_seen WHERE seen_at < ?').run(new Date(now - EVENTS_RETENTION_DAYS * DAY_MS).toISOString());
  const notices = createNoticesRepo(db);
  const noticeCut = new Date(now - NOTICE_RETENTION_DAYS * DAY_MS).toISOString();
  notices.expire(noticeCut, new Date(now).toISOString());
  notices.purge(noticeCut);
}

async function listenInternal(internal: FastifyInstance, config: HubConfig): Promise<void> {
  await mkdir(config.runDir, { recursive: true, mode: RUN_DIR_MODE });
  const socketPath = hubSocketPath(config);
  await rm(socketPath, { force: true });
  await internal.listen({ path: socketPath });
  await chmod(socketPath, SOCKET_MODE);
}

/**
 * Who is in front of the hub: Cloudflare Access in `cloudflare-access` mode, else the owner label in `local` mode,
 * where the session, its page key, Origin and CSRF are the gate.
 */
function accessFor(config: HubConfig): AccessVerifier {
  if (authModeOf(config) === 'cloudflare-access') {
    const { cfTeamDomain, cfAccessAud, ownerEmail } = config;
    // assertStartable refused an Access install without these (config/load.ts).
    if (cfTeamDomain === undefined || cfAccessAud === undefined || ownerEmail === undefined) {
      throw new Error('cloudflare-access mode needs cfTeamDomain, ownerEmail and CF_ACCESS_AUD');
    }
    return createAccessVerifier({ teamDomain: cfTeamDomain, aud: cfAccessAud, ownerEmail });
  }
  return createLocalIdentity(ownerLabelOf(config));
}

/** The owner's zone and the manager's name follow the settings. */
function applyPersonalSettings(settings: Settings): void {
  if (settings.owner_tz !== null) setOwnerZone(settings.owner_tz);
  setManagerName(settings.manager_name);
}

export function wireCore(ctx: WireContext): Wired {
  const { config, overrides } = ctx;
  const log = ctx.provide('log', overrides.log ?? createLogger());
  const db = ctx.provide('db', overrides.db ?? openDb(posix.join(config.dataDir, 'hub.db')));
  const ownsDb = overrides.db === undefined;
  const bus = ctx.provide('bus', createBus((err, event) => log.error({ err, event }, 'bus: listener failed')));
  const clock = ctx.provide('clock', overrides.clock ?? systemClock);
  ctx.provide('config', config);
  const settings = ctx.provide('settings', createSettingsService({ db, bus }));
  const access = ctx.provide('access', overrides.access ?? accessFor(config));
  // The page key and the Host check are always on in the hub.
  const pageKey = createPageKeyCheck(createSessionStore({ db, clock }));
  const hostCheck = createHostCheck(config, allowedHostsOf(config));
  applyPersonalSettings(settings.get());
  const offSettings = bus.on('settings.updated', applyPersonalSettings);
  const bindHost = bindHostOf(config);
  let stopSweeps: () => void = () => undefined;

  const startSweeps = (): void => {
    const guarded = (name: string, fn: () => void) => (): void => {
      try {
        fn();
      } catch (err) {
        log.error({ err, sweep: name }, 'app: sweep failed');
      }
    };
    const expire = guarded('actions', () => {
      ctx.get('actions').sweepExpired();
    });
    const retention = guarded('retention', () => sweepRetention(db, clock));
    retention();
    const timers = [setInterval(expire, ACTION_SWEEP_MS), setInterval(retention, DAY_MS)];
    stopSweeps = () => timers.forEach((timer) => clearInterval(timer));
  };

  return {
    name: 'core',
    services: { settings, bus },
    web: { config, db, bus, clock, log, settings, access, classify: classifyCommand, pageKey, hostCheck },
    tools: { settings, clock },
    async compose(all) {
      const webDeps = all.web as WebDeps;
      ctx.traceKeys('webDeps', Object.keys(webDeps));
      ctx.provide('webServer', await createWebServer(webDeps));
    },
    async start(phase) {
      if (phase === 'services') {
        await ctx.start('sweeps', startSweeps);
      } else if (phase === 'listen') {
        await ctx.start('listen.internal', () => listenInternal(ctx.get('internalServer'), config));
        await ctx.start('listen.web', () => ctx.get('webServer').listen({ host: bindHost, port: config.webPort }));
        const voice = ctx.get('voiceServer');
        if (voice !== null) await ctx.start('listen.voice', () => voice.listen({ host: bindHost, port: VOICE_PORT }));
      }
    },
    async stop(phase) {
      if (phase === 'listen') {
        await ctx.stop('web', () => ctx.get('webServer').close());
        const voice = ctx.get('voiceServer');
        if (voice !== null) await ctx.stop('voice', () => voice.close());
        await ctx.stop('internal', () => ctx.get('internalServer').close());
      } else if (phase === 'services') {
        await ctx.stop('sweeps', () => stopSweeps());
        offSettings();
      } else if (phase === 'infra' && ownsDb) {
        await ctx.stop('db', () => db.close());
      }
    },
  };
}
