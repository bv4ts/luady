import { z } from 'zod';
import { HostIdSchema, NewHostIdSchema, PinSchema } from './ids.js';
import { LIMITS } from './limits.js';

/**
 * Hosts from the website: SSH servers and "this computer" (kind `local`, id `computer`), all rows of the
 * hosts table. The self host is never a row.
 */
export const HOST_KINDS = ['ssh', 'local'] as const;
export type HostKind = (typeof HOST_KINDS)[number];
export const HOST_SOURCES = ['config', 'web'] as const;
export const HOST_STATES = ['draft', 'pinned', 'removed'] as const;
export type HostState = (typeof HOST_STATES)[number];
export const HOST_LINKS = ['online', 'offline', 'connecting'] as const;
export const HOST_ERRORS = ['auth', 'network', 'hostkey'] as const;
export const HOST_JOB_STATES = ['running', 'done', 'failed'] as const;
export const HOST_KIT_MODES = ['install', 'update', 'uninstall'] as const;
/** The header a host's grant travels in: scan, pin, check and kit need it. */
export const HOST_GRANT_HEADER = 'x-hub-grant';
/** What `check` found: `denied` stops retrying until "Try again". */
export const HOST_CHECK_RESULTS = ['ok', 'denied', 'unreachable', 'hostkey-mismatch'] as const;

/** OpenSSH SHA256 fingerprint: `SHA256:` + 43 unpadded base64 characters. */
export const HOST_KEY_FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
export const UNIX_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
/** A host's paths: absolute, safe characters, no `..`. */
export const HOST_PATH_RE = /^\/(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/;
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const IPV6_RE = /^[0-9A-Fa-f:.]{2,45}$/;

/** A host name or an IPv4/IPv6 literal, at most 253 characters, no leading `-`; refused ranges are checked at connect time. */
export const HostAddressSchema = z.string().max(LIMITS.hostNameMax)
  .refine((value) => !value.startsWith('-') && (HOSTNAME_RE.test(value) || (value.includes(':') && IPV6_RE.test(value))), {
    message: 'must be a host name or an IP address',
  });
export const UnixUserSchema = z.string().regex(UNIX_USER_RE);
export const HostPathSchema = z.string().regex(HOST_PATH_RE);
export const HostKeyFingerprintSchema = z.string().regex(HOST_KEY_FP_RE);
const Port = z.number().int().min(1).max(65535);

export const HostDTOSchema = z.object({
  id: HostIdSchema, kind: z.enum(HOST_KINDS), host: z.string(), user: z.string(), port: Port,
  source: z.enum(HOST_SOURCES), state: z.enum(HOST_STATES), fingerprint: z.string().nullable(),
  /** The live link; null while there is none (a draft, a removed host). */
  link: z.enum(HOST_LINKS).nullable(),
  lastError: z.enum(HOST_ERRORS).nullable(),
  kitVersion: z.string().nullable(), kitAlias: z.string().nullable(),
  claudeVersion: z.string().nullable(), claudeSignedIn: z.boolean().nullable(),
  projectsRoot: z.string().nullable(), homeDir: z.string().nullable(),
  /** False for the local host: it has no web terminal. */
  terminal: z.boolean(),
  fromAddr: z.string().nullable(),
  createdAt: z.string().nullable(), updatedAt: z.string().nullable(),
});
export type HostDTO = z.infer<typeof HostDTOSchema>;
export const HostsDTOSchema = z.array(HostDTOSchema);

export const HostKeyDTOSchema = z.object({ publicKey: z.string(), line: z.string() });
export type HostKeyDTO = z.infer<typeof HostKeyDTOSchema>;

export const HostCreateBodySchema = z.strictObject({
  id: NewHostIdSchema, host: HostAddressSchema, user: UnixUserSchema, port: Port,
  projectsRoot: HostPathSchema.optional(), homeDir: HostPathSchema.optional(), claudeBin: HostPathSchema.optional(), pin: PinSchema,
});
export type HostCreateBody = z.infer<typeof HostCreateBodySchema>;

/** "This computer": no id (it is `computer`); `createFolder` makes the projects folder at 0700 inside the hub user's home. */
export const HostLocalBodySchema = z.strictObject({
  projectsRoot: HostPathSchema, claudeBin: HostPathSchema.optional(), createFolder: z.boolean().optional(), pin: PinSchema,
});
export type HostLocalBody = z.infer<typeof HostLocalBodySchema>;

/** PUT: web rows only; an address, user or port change returns the host to `draft`. */
export const HostUpdateBodySchema = z.strictObject({
  host: HostAddressSchema.optional(), user: UnixUserSchema.optional(), port: Port.optional(),
  projectsRoot: HostPathSchema.optional(), homeDir: HostPathSchema.optional(), claudeBin: HostPathSchema.optional(), pin: PinSchema,
});
export type HostUpdateBody = z.infer<typeof HostUpdateBodySchema>;

export const HostGrantBodySchema = z.strictObject({ pin: PinSchema });
export const HostGrantDTOSchema = z.object({ grant: z.string(), expiresAt: z.string() });
export type HostGrantDTO = z.infer<typeof HostGrantDTOSchema>;
export const HostCreatedDTOSchema = z.object({ host: HostDTOSchema, grant: z.string() });
export type HostCreatedDTO = z.infer<typeof HostCreatedDTOSchema>;

export const HostScanDTOSchema = z.object({ fingerprint: z.string(), keyType: z.string(), compare: z.string() });
export type HostScanDTO = z.infer<typeof HostScanDTOSchema>;
export const HostPinBodySchema = z.strictObject({ fingerprint: HostKeyFingerprintSchema });
export const HostCheckDTOSchema = z.object({
  auth: z.enum(HOST_CHECK_RESULTS), preflight: z.record(z.string(), z.string()).nullable(), missing: z.array(z.string()),
  /** After `denied`: the key line again, to paste once more before "Try again". */
  line: z.string().max(2000).optional(),
});
export type HostCheckDTO = z.infer<typeof HostCheckDTOSchema>;

export const HostKitBodySchema = z.strictObject({ mode: z.enum(HOST_KIT_MODES) });
export const HostJobDTOSchema = z.object({
  job: z.string(), state: z.enum(HOST_JOB_STATES), summary: z.string().max(LIMITS.hostSummaryMax).nullable(), error: z.string().nullable(),
});
export type HostJobDTO = z.infer<typeof HostJobDTOSchema>;

export const HostRemoveBodySchema = z.strictObject({
  uninstallKit: z.boolean(), removeKey: z.boolean(), rooms: z.enum(['delete', 'keep']), pin: PinSchema,
});
export type HostRemoveBody = z.infer<typeof HostRemoveBodySchema>;

/** How one removal step went: done, not asked, failed, or the server could not be reached. */
export const HOST_REMOVE_OUTCOMES = ['done', 'skipped', 'failed', 'unreachable'] as const;
export type HostRemoveOutcome = (typeof HOST_REMOVE_OUTCOMES)[number];
/** What a removal did, step by step; `note` and `keyCommand` say what is left on an unreachable server. */
export const HostRemoveResultDTOSchema = z.object({
  host: HostIdSchema,
  steps: z.object({
    kit: z.enum(HOST_REMOVE_OUTCOMES), key: z.enum(HOST_REMOVE_OUTCOMES), link: z.literal('closed'), record: z.literal('removed'),
    rooms: z.enum(['deleted', 'kept']),
  }),
  note: z.string().max(2000).nullable(),
  keyCommand: z.string().max(2000).nullable(),
});
export type HostRemoveResultDTO = z.infer<typeof HostRemoveResultDTOSchema>;
