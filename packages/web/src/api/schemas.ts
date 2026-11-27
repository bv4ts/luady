import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { ActionDTOSchema } from '@luady/shared';
import { z } from 'zod';

/** Response shapes defined here rather than in the shared package. */
export const OkSchema = z.object({ ok: z.literal(true) });
/** `pageKey`: sent by a hub that issues page keys; an older hub sends none. */
export const LoginVerifySchema = z.object({ ok: z.literal(true), csrf: z.string().min(1), pageKey: z.string().min(1).optional() });
export const RegisterVerifySchema = z.object({ ok: z.literal(true), pageKey: z.string().min(1).optional() });
export const TicketSchema = z.object({ ticket: z.string().min(16).max(512) });

/**
 * POST /api/manager/messages: `{ ok: true }`, plus `held: true` from a newer hub while Luady is signed out (it keeps the
 * message and passes it on after sign-in). Anything else in `held` reads as not held.
 */
export const LuadySendResultSchema = z.looseObject({ ok: z.literal(true) }).transform((body): { ok: true; held?: boolean } => ({
  ok: true,
  held: body.held === true,
}));

/**
 * POST /api/sessions/:id/resume: the action, plus from a newer hub what the resume did: `wasHit` (the pause had
 * stopped the agent) and `sent` (the kit typed the resume text). An older hub sends no field; a malformed one is dropped.
 */
export const ResumeAnswerSchema = ActionDTOSchema.extend({
  resume: z.object({ wasHit: z.boolean(), sent: z.boolean() }).optional().catch(undefined),
});
export type ResumeAnswer = z.output<typeof ResumeAnswerSchema>;

export const MemoryListSchema = z.object({
  files: z.array(z.object({ name: z.string().min(1), size: z.number().int().nonnegative() })),
});
export type MemoryList = z.infer<typeof MemoryListSchema>;
export type MemoryEntry = MemoryList['files'][number];

export const MemoryFileSchema = z.object({ name: z.string().min(1), content: z.string() });
export type MemoryFile = z.infer<typeof MemoryFileSchema>;

/** GET /api/auth/passkeys. `id` is the credential id. */
export const PasskeyListSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    label: z.string(),
    createdAt: z.string().min(1),
    lastUsedAt: z.string().min(1).nullable(),
  })),
});
export type PasskeyList = z.infer<typeof PasskeyListSchema>;
export type PasskeyEntry = PasskeyList['items'][number];

const CredentialSchema = z.looseObject({ id: z.string().min(1), type: z.literal('public-key') });

/** WebAuthn options from @simplewebauthn/server: check what the browser needs and keep the rest. */
export const CreationOptionsSchema = z
  .looseObject({
    challenge: z.string().min(16),
    rp: z.looseObject({ name: z.string().min(1) }),
    user: z.looseObject({ id: z.string().min(1), name: z.string(), displayName: z.string() }),
    pubKeyCredParams: z.array(z.looseObject({ alg: z.number().int(), type: z.literal('public-key') })).min(1),
    excludeCredentials: z.array(CredentialSchema).optional(),
  })
  .transform((value) => value as unknown as PublicKeyCredentialCreationOptionsJSON);

export const RequestOptionsSchema = z
  .looseObject({
    challenge: z.string().min(16),
    rpId: z.string().optional(),
    allowCredentials: z.array(CredentialSchema).optional(),
  })
  .transform((value) => value as unknown as PublicKeyCredentialRequestOptionsJSON);
