import { z } from 'zod';

/**
 * The hub machine's own manager host: a fixed, reserved id. This file is the only place the value appears; everything
 * else compares through isSelfHost().
 */
export const SELF_HOST_ID = 'hq';
/** "This computer": the local host's fixed id, reserved so that no SSH host can take it. */
export const LOCAL_HOST_ID = 'computer';

/** Host ids: 2-24 characters, lower-case letters, digits and inner dashes; never ':' (a session id is host:target). */
export const HOST_ID_RE = /^[a-z][a-z0-9-]{0,22}[a-z0-9]$/;
/** Ids no new host may take: the self host, the local host `computer`, and words the website and the map use. */
export const RESERVED_IDS = ['hq', 'all', 'any', 'none', 'lobby', 'corridor', 'setup', 'new', 'codex', 'computer'] as const;
export const RESERVED_PREFIXES = ['lot-', 'vacant-'] as const;
export type HostId = string;

/** The channels the hub has itself; every other channel id is an add-on's. */
export const BUILTIN_CHANNELS = ['web', 'phone', 'event', 'scheduled', 'remote_control'] as const;
export type BuiltinChannel = (typeof BUILTIN_CHANNELS)[number];
/** Add-on ids: 2-24 characters, a lower-case letter first; also the grammar of an add-on's channel id. */
export const ADDON_ID_RE = /^[a-z][a-z0-9-]{1,23}$/;
/** Names an add-on may not take: the built-in channels and the role names. */
export const RESERVED_ADDON_IDS = [...BUILTIN_CHANNELS, 'chat', 'manager', 'hub'] as const;
/** A channel: a built-in one, or an add-on's id. Open, so the rows of a removed add-on still parse. */
export type Channel = BuiltinChannel | (string & {});

export const QID_RE = /^[A-Z2-7]{8}$/;
export const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const TARGET_RE = /^[A-Za-z0-9._-]{1,64}:\d{1,3}\.\d{1,3}$/;
export const ACTION_ID_RE = /^A[1-9]\d{0,8}$/;
export const PIN_RE = /^\d{6,12}$/;
/** The host-id grammar only (valid on the wire and in rows); accepts the self host and the local host. */
export function isHostId(value: string): boolean {
  return HOST_ID_RE.test(value);
}

/** An id a user may choose for a new host: the grammar, not reserved, and no reserved prefix. */
export function isNewHostId(value: string): boolean {
  return isHostId(value)
    && !(RESERVED_IDS as readonly string[]).includes(value)
    && !RESERVED_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/** True for the hub machine's own manager host: the only place a host is compared with the fixed id. */
export function isSelfHost(host: string): boolean {
  return host === SELF_HOST_ID;
}

/** True for the local host ("this computer"), whose id is fixed. */
export function isLocalHost(host: string): boolean {
  return host === LOCAL_HOST_ID;
}

/** A built-in channel of the hub (web, phone, event, scheduled, remote control). */
export function isBuiltinChannel(channel: string): channel is BuiltinChannel {
  return (BUILTIN_CHANNELS as readonly string[]).includes(channel);
}

/** An add-on id: the grammar, and not a built-in channel or role name. Also the grammar of an add-on's channel. */
export function isAddonId(value: string): boolean {
  return ADDON_ID_RE.test(value) && !(RESERVED_ADDON_IDS as readonly string[]).includes(value);
}

/** A channel that is a chat add-on's (the owner's chat app), not one of the hub's built-in channels. */
export function isChatChannel(channel: string | null | undefined): boolean {
  return typeof channel === 'string' && isAddonId(channel);
}

export const PinSchema = z.string().regex(PIN_RE);

/** Grammar only: valid on the wire, in rows and in route parameters; accepts the self host and the local host. */
export const HostIdSchema = z.string().regex(HOST_ID_RE);
/** Ids a user may choose for a NEW host (POST /api/hosts, config servers[].name): not reserved, no reserved prefix. */
export const NewHostIdSchema = HostIdSchema.refine(isNewHostId, { message: 'reserved host id' });

export function makeSessionId(host: HostId, target: string): string {
  return `${host}:${target}`;
}

export function parseSessionId(id: string): { host: HostId; target: string } | null {
  const idx = id.indexOf(':');
  if (idx <= 0) return null;
  const host = id.slice(0, idx);
  const target = id.slice(idx + 1);
  if (!(isHostId(host) || isSelfHost(host)) || !TARGET_RE.test(target)) return null;
  return { host, target };
}

/** The absolute path with `.` and `..` resolved, or null when it is not absolute, climbs above `/` or holds NUL/newline. */
function normalizeAbsolute(path: string): string | null {
  if (!path.startsWith('/') || path.includes('\0') || path.includes('\n')) return null;
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join('/')}`;
}

/** True when `path` is absolute and, after resolving `.`/`..` segments, equals `root` or lies inside it. */
export function isUnderRoot(path: string, root: string): boolean {
  const normalized = normalizeAbsolute(path);
  const base = normalizeAbsolute(root);
  if (normalized === null || base === null) return false;
  return normalized === base || normalized.startsWith(base === '/' ? '/' : `${base}/`);
}
