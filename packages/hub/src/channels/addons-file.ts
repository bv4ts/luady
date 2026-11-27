import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isAddonId } from '@luady/shared';
import { addonsDir } from '../config/defaults.js';
import { FILE_MODE, ensureDir, writeFileAtomic } from '../config/files.js';
import type { HubConfig, Logger } from '../core/contracts.js';

/** One declared add-on (config.json `addons[]`). */
export interface AddonDecl {
  readonly id: string;
  readonly kind: 'channel' | 'tools';
  readonly name: string;
  /** The owner's address in that chat app; channels only. The one source of the owner gate. */
  readonly owner: string | null;
  readonly primary: boolean;
}

export interface AddonRegistry {
  list(): readonly AddonDecl[];
  get(id: string): AddonDecl | undefined;
  /** The channel the hub reaches the owner on: the one marked primary, else the only channel; null otherwise. */
  primary(): AddonDecl | null;
  /** Whether `bearer` (an Authorization header value) carries this add-on's own token. Constant time. */
  tokenMatches(id: string, bearer: string | undefined): boolean;
  /** Whether `bearer` carries any add-on's token: such a token is refused (403) everywhere but its own route. */
  isAddonToken(bearer: string | undefined): boolean;
  /** The only folder whose files this add-on may hand to the hub: `<dataDir>/addons/<id>/files/`. */
  filesDir(id: string): string;
}

/** 32 random bytes as hex. */
const TOKEN_RE = /^[0-9a-f]{64}$/;
const BEARER = 'Bearer ';

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** The token presented in an Authorization header, or null. */
function presented(bearer: string | undefined): string | null {
  return typeof bearer === 'string' && bearer.startsWith(BEARER) ? bearer.slice(BEARER.length) : null;
}

function readToken(path: string): string | null {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return TOKEN_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** The add-on's token: kept when the file holds one (its mode tightened to 0600), else a new one written at 0600. */
function ensureToken(dir: string, id: string, log: Logger): string {
  const path = join(dir, `${id}.token`);
  const existing = readToken(path);
  if (existing !== null) {
    try {
      if ((statSync(path).mode & 0o077) !== 0) {
        chmodSync(path, FILE_MODE);
        log.warn({ addon: id }, 'addons: a token file was readable by others; tightened to 0600');
      }
    } catch (err) {
      log.warn({ addon: id, err: err instanceof Error ? err.message : String(err) }, 'addons: could not check a token file mode');
    }
    return existing;
  }
  const token = randomBytes(32).toString('hex');
  writeFileAtomic(path, `${token}\n`, FILE_MODE);
  log.info({ addon: id }, 'addons: wrote a new add-on token');
  return token;
}

function declsOf(config: Partial<Pick<HubConfig, 'addons'>>, log: Logger): AddonDecl[] {
  const seen = new Set<string>();
  const decls: AddonDecl[] = [];
  for (const addon of config.addons ?? []) {
    // config/schema.ts refuses these at load; this guard keeps a hand-built config (tests, the preview) as safe.
    if (!isAddonId(addon.id) || seen.has(addon.id) || (addon.kind === 'channel' && addon.owner === undefined)) {
      log.warn({ addon: addon.id }, 'addons: skipped an add-on the config does not allow');
      continue;
    }
    seen.add(addon.id);
    decls.push({ id: addon.id, kind: addon.kind, name: addon.name, owner: addon.kind === 'channel' ? addon.owner ?? null : null, primary: addon.primary === true });
  }
  return decls;
}

/**
 * The declared add-ons and their tokens. Each token lives in `<dataDir>/addons/<id>.token` (0600) and is made on the
 * first start; only its sha256 stays in memory. A token is never logged, never returned by any route.
 */
export function loadAddons(deps: { config: Pick<HubConfig, 'dataDir'> & Partial<Pick<HubConfig, 'addons'>>; log: Logger }): AddonRegistry {
  const dir = addonsDir(deps.config);
  const decls: readonly AddonDecl[] = declsOf(deps.config, deps.log);
  const digests = new Map<string, Buffer>();
  if (decls.length > 0) ensureDir(dir);
  for (const decl of decls) {
    digests.set(decl.id, digest(ensureToken(dir, decl.id, deps.log)));
    ensureDir(join(dir, decl.id, 'files'));
  }
  const matches = (stored: Buffer, bearer: string | undefined): boolean => {
    const token = presented(bearer);
    return token !== null && timingSafeEqual(digest(token), stored);
  };

  return {
    list: () => decls,
    get: (id) => decls.find((decl) => decl.id === id),
    primary() {
      const channels = decls.filter((decl) => decl.kind === 'channel');
      return channels.find((decl) => decl.primary) ?? (channels.length === 1 ? channels[0] ?? null : null);
    },
    tokenMatches(id, bearer) {
      const stored = digests.get(id);
      return stored !== undefined && matches(stored, bearer);
    },
    isAddonToken(bearer) {
      let found = false;
      // Every token is compared, so the time taken does not tell which one matched.
      for (const stored of digests.values()) found = matches(stored, bearer) || found;
      return found;
    },
    filesDir: (id) => join(dir, id, 'files'),
  };
}
