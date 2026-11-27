import { z } from 'zod';
import { PinSchema } from './ids.js';

/** The first run: claim → pin → rooms → connect → extras → done. */
export const SETUP_STEPS = ['claim', 'pin', 'rooms', 'connect', 'extras', 'done'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
/** The steps the owner may skip. */
export const SKIPPABLE_SETUP_STEPS = ['passkey', 'rooms', 'connect', 'extras'] as const;
export type SkippableSetupStep = (typeof SKIPPABLE_SETUP_STEPS)[number];
export const AUTH_MODES = ['local', 'cloudflare-access'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const SetupStateDTOSchema = z.object({
  step: z.enum(SETUP_STEPS), claimed: z.boolean(), authMode: z.enum(AUTH_MODES),
  remote: z.boolean(), skipped: z.array(z.enum(SKIPPABLE_SETUP_STEPS)),
});
export type SetupStateDTO = z.infer<typeof SetupStateDTOSchema>;

export const SetupStepBodySchema = z.strictObject({ step: z.enum(SKIPPABLE_SETUP_STEPS), action: z.enum(['done', 'skip']) });
export type SetupStepBody = z.infer<typeof SetupStepBodySchema>;

/** `POST /api/setup/login`: a single-use login token (5 minutes), plus the PIN once one is set. */
export const SetupLoginBodySchema = z.strictObject({ token: z.string().min(16).max(128), pin: PinSchema.optional() });
export type SetupLoginBody = z.infer<typeof SetupLoginBodySchema>;

/** The page key: returned only by a passkey sign-in or registration, a login link or a claim. */
export const PageKeyDTOSchema = z.object({ pageKey: z.string().min(32).max(128) });
export type PageKeyDTO = z.infer<typeof PageKeyDTOSchema>;
/** The header every `/api` request carries the page key in, and where the website keeps it. */
export const PAGE_KEY_HEADER = 'x-hub-key';
export const PAGE_KEY_STORAGE = 'hub.pageKey';
