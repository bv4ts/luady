// Starts the demo (preview/demo.ts, the real hub with a pretend fleet) in this process, on a free port.
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { freePort } from './browser.mjs';

/** The demo's PIN (preview/config.ts); the first-run pictures choose the same one. */
export const DEMO_PIN = '123456';

async function loadDemo(repoRoot) {
  return import(pathToFileURL(join(repoRoot, 'preview', 'demo.ts')).href);
}

/**
 * The demo as `npm run demo -- --rooms <rooms> --still --clock <clock> --port <free port>` starts it: it refuses a
 * production machine and builds first when the build is missing or older than the sources. `keep` keeps its data in a
 * folder (the first-run pictures need the database file).
 */
export async function startDemo(repoRoot, { rooms, clock, keep }) {
  const demo = await loadDemo(repoRoot);
  const port = await freePort();
  const deps = { ...demo.processDemoDeps(), onLoginLink: () => undefined };
  const preview = await demo.startDemo({ rooms, loop: false, clock, port, keep, open: false }, deps);
  await preview.ready;
  console.log(`  demo up on port ${port} (rooms: ${rooms})`);
  return preview;
}

/** The office demo: the classic four servers with their sessions, board, notes and Jira; nothing moves on its own. */
export function startOfficeDemo(repoRoot, clock) {
  return startDemo(repoRoot, { rooms: 'classic', clock, keep: undefined });
}

/**
 * A demo that looks like a new install nobody has claimed: no rooms, no sessions, no servers, no PIN, no time zone,
 * the setup wizard at its first step and the manager off. The demo always finishes its own first run, so after it starts this
 * puts its database back to a new install's first-run rows, with the statements `npm run luady -- pin reset` and the
 * first migration use. Returns the demo and a way to remove its folder.
 */
export async function startNewInstallDemo(repoRoot, clock) {
  const folder = await mkdtemp(join(tmpdir(), 'luady-docs-pictures-'));
  const preview = await startDemo(repoRoot, { rooms: 0, clock, keep: folder });
  const require = createRequire(join(repoRoot, 'packages', 'hub', 'package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(join(folder, 'data', 'hub.db'));
  try {
    db.prepare('UPDATE pin_state SET hash = NULL, failed_count = 0, lockouts = 0, locked_until = NULL WHERE id = 1').run();
    db.prepare("UPDATE setup_state SET step = 'claim', skipped_json = '[]', completed_at = NULL WHERE id = 1").run();
    // The demo's four pretend servers are written as rows from its config; a new install has none.
    db.prepare('DELETE FROM servers').run();
  } finally {
    db.close();
  }
  // No zone yet, as on a new install: the claim then stores the browser's.
  preview.app.services.settings.update({ manager_enabled: false, owner_tz: null });
  preview.app.services.setup.notify();
  const remove = async () => {
    await preview.stop();
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  };
  return { preview, remove };
}
