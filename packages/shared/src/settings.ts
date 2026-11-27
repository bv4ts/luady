import { z } from 'zod';
import { PinSchema } from './ids.js';
import { isTimeZone } from './pure/owner-time.js';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** Claude Code `--effort` levels for Luady's brain, lowest to highest. */
export const LUADY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type LuadyEffort = (typeof LUADY_EFFORTS)[number];
/** The languages a phone call can speak and listen in (hub phone/speech.ts VOICE_LANGUAGES has each one's voice). */
export const CALL_LANGUAGES = ['en', 'ar', 'de', 'fr', 'pt'] as const;
export type CallLanguage = (typeof CALL_LANGUAGES)[number];

export const SettingsSchema = z.strictObject({
  escalate_after_min: z.number().int().min(1).max(240),
  hook_wait_seconds: z.number().int().min(60).max(86400),
  finished_min_seconds: z.number().int().min(0).max(86400),
  /** In the owner's zone (`owner_tz`); a stored legacy `tz` key is accepted and ignored. */
  quiet_hours: z.strictObject({ start: HHMM, end: HHMM, tz: z.string().max(64).optional() }),
  night_calls: z.boolean(),
  away: z.boolean(),
  phone_enabled: z.boolean(),
  call_rate_per_hour: z.number().int().min(0).max(10),
  /** The languages a call offers, the first one first; the call switches to another when the manager answers in it. */
  call_languages: z.array(z.enum(CALL_LANGUAGES)).min(1).max(CALL_LANGUAGES.length)
    .refine((list) => new Set(list).size === list.length, { message: 'each language once' }),
  manager_model: z.string().min(1).max(64),
  /** How hard Luady thinks each turn; applies when the brain next starts (daily rotation or restart). */
  manager_effort: z.enum(LUADY_EFFORTS),
  voice_model: z.string().min(1).max(64),
  graphify_time: HHMM,
  digest_time: HHMM,
  rotate_time: HHMM,
  /** false = Luady's risky (tier-1) actions run without the owner PIN. */
  require_pin: z.boolean(),
  /** ISO time until which finished/error/ended notices and mission-done messages stay silent; null = not muted. */
  mute_until: z.string().datetime().nullable(),
  /**
   * The owner's IANA zone; every owner-facing time uses it (pure/owner-time.ts). Null until the hub records one.
   */
  owner_tz: z.string().min(1).max(64).refine(isTimeZone, { message: 'unknown time zone' }).nullable(),
  /** The manager is optional; off on a new install (the setup box is unticked). */
  manager_enabled: z.boolean(),
  /** The manager's display name (pure/display.ts). */
  manager_name: z.string().trim().min(1).max(40),
  /** The nightly summary and the morning brief. */
  digest_enabled: z.boolean(),
  brief_enabled: z.boolean(),
  /** The nightly Claude Code update on every server, the tools update and the code-map run. */
  claude_update_enabled: z.boolean(),
  tools_update_enabled: z.boolean(),
  graphify_enabled: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** The settings keys this release knows (settings.key); the hub keeps a few more of its own beside them. */
export const SETTINGS_KEYS = Object.freeze(Object.keys(SettingsSchema.shape) as (keyof Settings)[]);

/**
 * A change to the settings. `pin` is never stored: it confirms a change that needs the owner's PIN (turning
 * `require_pin` off), and the settings route checks it before anything is written.
 */
export const SettingsPatchSchema = SettingsSchema.partial().extend({ pin: PinSchema.optional() });
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = {
  escalate_after_min: 10,
  hook_wait_seconds: 14400,
  finished_min_seconds: 120,
  quiet_hours: { start: '00:00', end: '08:00' },
  night_calls: false,
  away: false,
  phone_enabled: false,
  call_rate_per_hour: 3,
  call_languages: ['en'],
  manager_model: 'opus',
  manager_effort: 'high',
  voice_model: 'sonnet',
  graphify_time: '02:00',
  digest_time: '03:30',
  rotate_time: '04:00',
  require_pin: true,
  mute_until: null,
  owner_tz: null,
  manager_enabled: false,
  manager_name: 'Luady',
  digest_enabled: false,
  brief_enabled: false,
  claude_update_enabled: false,
  tools_update_enabled: false,
  graphify_enabled: false,
};
