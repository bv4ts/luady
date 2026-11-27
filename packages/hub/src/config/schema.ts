import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ADDON_KINDS, AUTH_MODES, AddonIdSchema, HostPathSchema, NewHostIdSchema, RoomImportSchema, isAddonId } from '@luady/shared';

/** OpenSSH SHA256 fingerprint as printed by `ssh-keygen -lf`: `SHA256:` + 43 unpadded base64 characters. */
export const HOST_KEY_FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
/** luady-ctl program path: `~/…` or `/…`, safe characters only, no `..`. It stays unquoted on the remote command line. */
export const CTL_PATH_RE = /^(?:~\/|\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/;
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const UNIX_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const HEX64_RE = /^[a-f0-9]{64}$/i;
/** An allowed Host value: a host name, an IPv4 address or a bracketed IPv6 address, with an optional port. */
const ALLOWED_HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;

const absolutePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => isAbsolute(value) && !/[\0\n\r]/.test(value), { error: 'must be an absolute path' });

/** A config server is a new host: the grammar, not reserved; the config is a read-only seed. */
export const ServerConfigSchema = z.strictObject({
  name: NewHostIdSchema,
  host: z.string().regex(HOSTNAME_RE, { error: 'must be a host name or IPv4 address' }),
  user: z.string().regex(UNIX_USER_RE, { error: 'must be a Unix user name' }),
  port: z.number().int().min(1).max(65535),
  hostKeyFp: z.string().regex(HOST_KEY_FP_RE, { error: 'must look like SHA256:<43 base64 characters>' }),
  /** The host's folders and Claude Code; an address restriction for its key line. */
  projectsRoot: HostPathSchema.optional(),
  homeDir: HostPathSchema.optional(),
  claudeBin: HostPathSchema.optional(),
  fromAddr: z.string().min(1).max(64).optional(),
});

/** "This computer": an optional seed for the local host row, whose id is fixed (`computer`). */
export const LocalHostConfigSchema = z.strictObject({
  projectsRoot: absolutePath, claudeBin: absolutePath.optional(), ctlPath: absolutePath.optional(),
});

/** A declared add-on: never a built-in channel or role name; `owner` is required for a channel. */
export const AddonConfigSchema = z.strictObject({
  id: AddonIdSchema.refine(isAddonId, { error: 'must not be a built-in channel or role name' }),
  kind: z.enum(ADDON_KINDS), name: z.string().min(1).max(80), owner: z.string().min(1).max(200).optional(), primary: z.boolean().optional(),
}).refine((addon) => addon.kind !== 'channel' || addon.owner !== undefined, { error: 'a channel add-on needs its owner' });

/**
 * config.json. Every field is optional: config/load.ts fills the defaults (config/defaults.ts) and
 * applies the seven startup refusals. Unknown keys are refused (strict), so a typo never passes silently. Duplicate
 * server names are a startup refusal (load.ts), not a schema error, so that they print the refusal's one line.
 */
export const ConfigFileSchema = z.strictObject({
  servers: z.array(ServerConfigSchema).optional(),
  fleetKeyPath: absolutePath.optional(),
  dataDir: absolutePath.optional(),
  brainDir: absolutePath.optional(),
  runDir: absolutePath.optional(),
  webDir: absolutePath.optional(),
  webPort: z.number().int().min(1).max(65535).optional(),
  publicOrigin: z
    .url({ protocol: /^https?$/ })
    .refine((value) => URL.canParse(value) && new URL(value).origin === value, {
      error: 'must be an origin such as https://host (no path, no trailing slash)',
    })
    .optional(),
  rpId: z.string().regex(HOSTNAME_RE, { error: 'must be a host name' }).optional(),
  /** The phone module only (Twilio). */
  ownerPhone: z.string().regex(/^\d{6,15}$/, { error: 'must be digits only, with the country code' }).optional(),
  /** Required in `cloudflare-access` mode (the hub refuses to start without it). */
  ownerEmail: z.email().optional(),
  cfTeamDomain: z.string().regex(/^[a-z0-9-]+\.cloudflareaccess\.com$/, { error: 'must be <team>.cloudflareaccess.com' }).optional(),
  claudePath: absolutePath.optional(),
  localCtlPath: absolutePath.optional(),
  remoteCtlPath: z.string().regex(CTL_PATH_RE, { error: 'must be ~/… or /… with safe characters only' }).optional(),
  voiceOrigin: z
    .url({ protocol: /^https$/ })
    .refine((value) => URL.canParse(value) && new URL(value).origin === value, { error: 'must be https://host (no path)' })
    .optional(),
  localHost: LocalHostConfigSchema.optional(),
  managerHome: absolutePath.optional(),
  managerFiles: z.enum(['own-folder', 'any']).optional(),
  rooms: z.array(RoomImportSchema).optional(),
  addons: z.array(AddonConfigSchema)
    .refine((list) => new Set(list.map((addon) => addon.id)).size === list.length, { error: 'add-on ids must be unique' })
    .refine((list) => list.filter((addon) => addon.primary === true).length <= 1, { error: 'at most one primary channel' })
    .optional(),
  fleetFrom: z.array(z.string().min(1).max(64)).optional(),
  /** The address the web server listens on; 127.0.0.1 when absent. Anything but loopback makes the install remote. */
  bindHost: z.union([z.ipv4(), z.ipv6()]).optional(),
  allowRemote: z.boolean().optional(),
  /** The Host check: `host` or `host:port` values; default the `host[:port]` of publicOrigin. */
  allowedHosts: z.array(z.string().regex(ALLOWED_HOST_RE, { error: 'must be host or host:port' })).min(1).optional(),
  /** `cloudflare` trusts CF-Connecting-IP from a loopback peer only (cloudflared runs on this machine). */
  trustedProxy: z.enum(['cloudflare']).nullable().optional(),
  authMode: z.enum(AUTH_MODES).optional(),
  ownerLabel: z.string().trim().min(1).max(40).optional(),
});
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

/** secrets.env. The hub generates the two hub secrets when missing; CF_ACCESS_AUD only in Access mode. */
export const SecretsSchema = z.object({
  CF_ACCESS_AUD: z.string().regex(/^[A-Za-z0-9]{16,128}$/, { error: 'must be the Access application AUD tag' }).optional(),
  SESSION_SECRET: z.string().regex(HEX64_RE, { error: 'must be 64 hex characters' }),
  HUB_SOCKET_TOKEN: z.string().regex(HEX64_RE, { error: 'must be 64 hex characters' }),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  IMAP_HOST: z.string().optional(),
  IMAP_PORT: z.string().optional(),
  IMAP_USER: z.string().optional(),
  IMAP_PASSWORD: z.string().optional(),
  IMAP_LABEL: z.string().optional(),
});

/** A non-Google mailbox over IMAP (cPanel, Zoho, Fastmail…), only when host, user and password are present. */
export function imapFromSecrets(secrets: Partial<Record<'IMAP_HOST' | 'IMAP_PORT' | 'IMAP_USER' | 'IMAP_PASSWORD' | 'IMAP_LABEL', string>>):
  { host: string; port: number; user: string; password: string; label: string } | null {
  const host = secrets.IMAP_HOST ?? '';
  const user = secrets.IMAP_USER ?? '';
  const password = secrets.IMAP_PASSWORD ?? '';
  const port = Number(secrets.IMAP_PORT ?? '993');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) || !/^[^\s@]+@[^\s@]+$/.test(user) || password === '' || !Number.isInteger(port)) return null;
  const label = (secrets.IMAP_LABEL ?? host.replace(/^(imap|mail)\./, '').split('.')[0] ?? 'mail').toLowerCase();
  return { host, port, user, password, label };
}

/** Google OAuth web client, only when both values look real. */
export function googleFromSecrets(secrets: Partial<Record<'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET', string>>):
  { clientId: string; clientSecret: string } | null {
  const id = secrets.GOOGLE_CLIENT_ID ?? '';
  const secret = secrets.GOOGLE_CLIENT_SECRET ?? '';
  return /^[\w-]+\.apps\.googleusercontent\.com$/.test(id) && /^[\w-]{20,}$/.test(secret) ? { clientId: id, clientSecret: secret } : null;
}

/** Phone credentials only when all three look real; placeholders or blanks mean "phone off", never a failed start. */
export function twilioFromSecrets(secrets: Partial<Record<'TWILIO_ACCOUNT_SID' | 'TWILIO_AUTH_TOKEN' | 'TWILIO_FROM', string>>):
  { accountSid: string; authToken: string; from: string } | null {
  const sid = secrets.TWILIO_ACCOUNT_SID ?? '';
  const token = secrets.TWILIO_AUTH_TOKEN ?? '';
  const from = secrets.TWILIO_FROM ?? '';
  return /^AC[0-9a-f]{32}$/.test(sid) && /^[0-9a-f]{32}$/.test(token) && /^\+\d{8,15}$/.test(from)
    ? { accountSid: sid, authToken: token, from }
    : null;
}
export type Secrets = z.infer<typeof SecretsSchema>;
