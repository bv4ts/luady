import { z } from 'zod';
import type { Clock, Db } from '../../core/contracts.js';
import { newId } from '../../core/ids.js';

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CHALLENGE_PURPOSES = ['register', 'register-setup', 'login'] as const;
export type ChallengePurpose = (typeof CHALLENGE_PURPOSES)[number];

export interface ChallengeStore {
  save(challenge: string, purpose: ChallengePurpose): void;
  /** Single use: deletes the row and returns its purpose; null when unknown or 5 minutes old. */
  take(challenge: string): ChallengePurpose | null;
}

const RowSchema = z.object({ id: z.string(), purpose: z.enum(CHALLENGE_PURPOSES), expires_at: z.string() });

export function createChallengeStore(deps: { db: Db; clock: Clock }): ChallengeStore {
  const { db, clock } = deps;
  const insert = db.prepare('INSERT INTO auth_challenges (id, challenge, purpose, expires_at) VALUES (?, ?, ?, ?)');
  const find = db.prepare('SELECT id, purpose, expires_at FROM auth_challenges WHERE challenge = ?');
  const remove = db.prepare('DELETE FROM auth_challenges WHERE id = ?');
  const purge = db.prepare('DELETE FROM auth_challenges WHERE expires_at <= ?');
  return {
    save(challenge, purpose) {
      const now = clock.now();
      purge.run(now.toISOString());
      insert.run(newId(), challenge, purpose, new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString());
    },
    take(challenge) {
      const parsed = RowSchema.safeParse(find.get(challenge));
      if (!parsed.success) return null;
      remove.run(parsed.data.id);
      return Date.parse(parsed.data.expires_at) > clock.now().getTime() ? parsed.data.purpose : null;
    },
  };
}
