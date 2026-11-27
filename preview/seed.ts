import { promptHash, type AskQuestion, type HostId } from '@luady/shared';
import { PREVIEW_PROJECTS_ROOT } from './config.ts';
import type { FakeKit } from './fake-kit.ts';
import type { PreviewFleet } from './fake-fleet.ts';

export interface SeedSession {
  readonly host: HostId;
  readonly name: string;
  readonly state: 'idle' | 'working' | 'question' | 'permission' | 'error';
  readonly quietMin: number;
}

const MINUTE_MS = 60_000;

const s = (host: HostId, name: string, state: SeedSession['state'], quietMin: number): SeedSession => ({ host, name, state, quietMin });

/** 25 sessions for the demo fleet: busy birch, a few on cedar and ash, two desks on local. */
export const SEED: readonly SeedSession[] = [
  s('cedar', 'meadow-hr', 'idle', 12), s('cedar', 'meadow-vat', 'working', 1), s('cedar', 'meadow-share', 'idle', 3),
  s('cedar', 'fitness-demo', 'working', 2),
  s('birch', 'app-backend', 'working', 1), s('birch', 'app-frontend', 'working', 3), s('birch', 'dev_orchard', 'idle', 4),
  s('birch', 'jira-1105', 'question', 11), s('birch', 'jira-1112', 'working', 2), s('birch', 'figma-sync', 'idle', 40),
  s('birch', 'store-desk', 'idle', 2), s('birch', 'checkout-fix', 'working', 6), s('birch', 'client-preferences', 'working', 1),
  s('birch', 'push-notifs', 'error', 11), s('birch', 'menu-import', 'idle', 7), s('birch', 'orders-api', 'working', 2),
  s('birch', 'qa-regression', 'permission', 11), s('birch', 'release-notes', 'idle', 25),
  s('ash', 'harbor-web-app', 'working', 1), s('ash', 'harbor-new-home', 'idle', 9), s('ash', 'portfolio-site', 'idle', 120),
  s('ash', 'harbor-admin', 'working', 4), s('ash', 'harbor-api', 'idle', 2),
  s('local', 'research-desk', 'idle', 15), s('local', 'picture-desk', 'working', 2),
];

export const SEED_QUESTION: readonly AskQuestion[] = [{
  question: 'Which approach should I take?',
  header: 'Approach',
  multiSelect: false,
  options: [{ label: 'Keep the old API' }, { label: 'Switch to the new API' }],
}];

const ASSISTANT_LINE: Readonly<Record<SeedSession['state'], string>> = {
  idle: 'Done. All tests pass.',
  working: 'On it. Reading the code first.',
  question: 'Before I go on, I need one decision from you.',
  permission: 'I need your permission to push.',
  error: 'Stopped: the usage limit was reached.',
};

export function projectCwd(name: string): string {
  return `${PREVIEW_PROJECTS_ROOT}/${name}`;
}

/** The `data` of a `prompt` spool event for this text, hashed like the kit hashes it. */
export function promptData(text: string): { prompt_sha256: string; prompt_preview: string } {
  return { prompt_sha256: promptHash(text), prompt_preview: text.slice(0, 200) };
}

function seedOne(kit: FakeKit, session: SeedSession): void {
  const pane = kit.addPane(session.name, projectCwd(session.name));
  const prompt = `Continue the ${session.name} task`;
  const quiet = { ageMs: session.quietMin * MINUTE_MS };
  kit.emit('session_start', pane.target, { source: 'startup', model: 'opus' }, { ageMs: (session.quietMin + 1) * MINUTE_MS });
  if (session.state !== 'idle') kit.emit('prompt', pane.target, promptData(prompt), quiet);
  if (session.state === 'question') kit.ask(pane.target, SEED_QUESTION, quiet);
  if (session.state === 'permission') kit.permit(pane.target, 'Bash', 'git push --force origin main', quiet);
  if (session.state === 'error') kit.emit('stop_failure', pane.target, { error: 'usage limit reached' }, quiet);
  kit.say(pane.target, 'user', prompt);
  kit.say(pane.target, 'assistant', ASSISTANT_LINE[session.state]);
}

/** Opens every seeded pane and replays its recent history into the kit's spool (the classic seed by default). */
export function applySeed(fleet: PreviewFleet, sessions: readonly SeedSession[] = SEED): void {
  for (const session of sessions) seedOne(fleet.kit(session.host), session);
}
