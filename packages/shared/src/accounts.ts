import { z } from 'zod';
import { RateWindowDTOSchema } from './activity.js';
import { HostIdSchema, isAddonId } from './ids.js';
import { HttpsUrlSchema } from './urls.js';

/**
 * Account identity rule (implemented by the hub): `claude:<org_id>` when the host reports an organisation id;
 * else `claude:<lower-cased e-mail>`; else `claude:host:<host>` (signed out, or a kit that reports neither).
 * The Codex sign-in is the single account `codex`.
 */
export const AccountHostDTOSchema = z.object({
  host: HostIdSchema,
  /** null = not checked yet or the host is unreachable. */
  loggedIn: z.boolean().nullable(),
  expiresAt: z.string().nullable(),
  checkedAt: z.string().nullable(),
  /** A sign-in link was issued and still waits for its code. */
  loginPending: z.boolean(),
  /** The host's kit is 2.0.0 or newer. */
  canLogout: z.boolean(),
});
export type AccountHostDTO = z.infer<typeof AccountHostDTOSchema>;

export const AccountLimitsDTOSchema = z.object({
  /** 'no' = meters arrived without any limit window: this plan does not report limits. */
  reported: z.enum(['yes', 'no', 'unknown']),
  fiveHour: RateWindowDTOSchema.nullable(),
  sevenDay: RateWindowDTOSchema.nullable(),
  updatedAt: z.string().nullable(),
});
export type AccountLimitsDTO = z.infer<typeof AccountLimitsDTOSchema>;

export const AccountDTOSchema = z.object({
  id: z.string().max(200),
  provider: z.enum(['claude', 'codex']),
  email: z.string().nullable(),
  orgName: z.string().nullable(),
  plan: z.string().nullable(),
  hosts: z.array(AccountHostDTOSchema),
  limits: AccountLimitsDTOSchema,
  /** Luady's own brain runs on this account. */
  isManager: z.boolean(),
  /** One line the website shows with this account (the ChatGPT sign-in to make again). Absent: none, or an older hub. */
  note: z.string().max(400).optional(),
});
export type AccountDTO = z.infer<typeof AccountDTOSchema>;

/** The connections the hub has itself; a chat add-on's row carries the add-on's id. */
export const CONNECTION_IDS = ['google', 'imap', 'wispr', 'jira'] as const;
/** The built-in connections, or any add-on id (open, like ChannelSchema). */
export const ConnectionIdSchema = z.string()
  .refine((value) => (CONNECTION_IDS as readonly string[]).includes(value) || isAddonId(value), { message: 'unknown connection' });

export const ConnectionDTOSchema = z.object({
  /** `jira`: one row per connected office (label "Jira · Orchard"). */
  id: ConnectionIdSchema,
  label: z.string(),
  state: z.enum(['connected', 'not_connected', 'unavailable']),
  detail: z.string().nullable(),
  connectUrl: HttpsUrlSchema.nullable(),
});
export type ConnectionDTO = z.infer<typeof ConnectionDTOSchema>;

/** The services the website connects through the connect flow (`POST /api/connect/:service`). */
export const CONNECT_SERVICES = ['google', 'wispr'] as const;
export type ConnectService = (typeof CONNECT_SERVICES)[number];

/**
 * The website page a connection row's `connectUrl` opens (on the hub's own origin): Settings with the connect step of
 * that service, which asks for the PIN and starts the connect flow.
 */
export function connectPagePath(service: ConnectService): string {
  return `/settings?connect=${service}`;
}

export const AccountsDTOSchema = z.object({ accounts: z.array(AccountDTOSchema), connections: z.array(ConnectionDTOSchema) });
export type AccountsDTO = z.infer<typeof AccountsDTOSchema>;

export const LoginStartDTOSchema = z.object({ host: HostIdSchema, url: HttpsUrlSchema, expiresAt: z.string() });
export type LoginStartDTO = z.infer<typeof LoginStartDTOSchema>;

/** The pasted code, trimmed of surrounding whitespace before its length is checked. */
export const LoginCodeBodySchema = z.strictObject({ code: z.string().trim().min(8).max(1100) });
export type LoginCodeBody = z.infer<typeof LoginCodeBodySchema>;

export const LoginResultDTOSchema = z.object({
  host: HostIdSchema,
  ok: z.boolean(),
  message: z.string(),
  loggedIn: z.boolean(),
  expiresAt: z.string().nullable(),
  brainRestarted: z.boolean(),
});
export type LoginResultDTO = z.infer<typeof LoginResultDTOSchema>;

export const CodexLoginDTOSchema = z.object({ url: HttpsUrlSchema, code: z.string().max(32), expiresAt: z.string() });
export type CodexLoginDTO = z.infer<typeof CodexLoginDTOSchema>;
