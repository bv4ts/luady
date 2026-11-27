import type { Db } from '../../src/core/contracts.js';
import { hashPin } from '../../src/security/pin-hash.js';

/** The PIN of a set-up test install; a suite that wants its own changes it (`pin.set(own, { currentPin: FIXTURE_PIN })`). */
export const FIXTURE_PIN = '246810';

let hashed: Promise<string> | null = null;

/**
 * Marks a test database as an install that finished its first run: it has a PIN and its setup is done, so the auth
 * chain no longer answers 409 setup_pending. For suites that sign a browser in by hand to test what an owner does. The
 * hash is made once per test worker (argon2 is slow on purpose).
 */
export async function markSetUp(db: Db): Promise<void> {
  hashed ??= hashPin(FIXTURE_PIN);
  db.prepare('UPDATE pin_state SET hash = ? WHERE id = 1').run(await hashed);
  db.prepare("UPDATE setup_state SET step = 'done', completed_at = updated_at WHERE id = 1").run();
}
