import { INTERNAL_PATHS, SELF_HOST_ID } from '@luady/shared';
import type { App } from '../packages/hub/dist/app.js';
import type { Db, HubConfig } from '../packages/hub/dist/core/contracts.js';
import type { StepCControls } from './board-scenarios.ts';
import { targetFor } from './fake-kit.ts';
import type { FakeJira } from './fake-jira.ts';
import { createFakeLuady, type ToolCall } from './fake-luady.ts';
import type { PreviewFleet } from './fake-fleet.ts';
import { RUNNING_SESSIONS, seedStepC } from './seed-step-c.ts';

/** Cards, notes and Jira in the preview hub: the fake Luady's tool path, the drive verbs' controls, the seed and the Jira connection. */

/** The office the fake Jira site belongs to. */
export const JIRA_OFFICE = 'birch' as const;
const SEED_WAIT_MS = 15_000;
const POLL_MS = 100;
/** A teammate comments a moment after the connection, so two tickets show a news dot. */
const NEWS_DELAY_MS = 1_500;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Calls a brain tool through the hub's internal server, the route the MCP server uses for the real Luady. */
export function internalTools(app: App, config: HubConfig): ToolCall {
  return async (name, args) => {
    const res = await app.internal.inject({
      method: 'POST', url: `${INTERNAL_PATHS.tools}/${name}`, headers: { authorization: `Bearer ${config.hubSocketToken}` }, payload: args,
    });
    const body = res.json<{ ok: boolean; text?: string; error?: string }>();
    if (!body.ok) throw new Error(`${name}: ${body.error ?? `HTTP ${res.statusCode}`}`);
    return body.text ?? '';
  };
}

export function stepCControls(app: App, jira: FakeJira): StepCControls {
  return {
    addCard: async (title) => (await app.services.board.add({ title, source: 'web' }, 'owner')).id,
    jiraOff: () => app.services.jira.disconnect(JIRA_OFFICE),
    jiraOn: async () => {
      await app.services.jira.connect(JIRA_OFFICE, jira.connectInput);
    },
  };
}

/** The manager pane's behaviour: the fake brain (fake-luady.ts) acting through the real tool route. */
export function attachFakeLuady(app: App, config: HubConfig, fleet: PreviewFleet, wait = sleep): void {
  const kit = fleet.kit(SELF_HOST_ID);
  kit.onSend(createFakeLuady({
    kit,
    tools: internalTools(app, config),
    sessions: () => app.services.sessions.list(),
    paneExists: (server, name) => fleet.kit(server).pane(targetFor(server, name)) !== undefined,
    wait,
    log: (text) => console.warn(text),
  }));
}

async function sessionsKnown(app: App): Promise<boolean> {
  const end = Date.now() + SEED_WAIT_MS;
  const wanted = Object.values(RUNNING_SESSIONS);
  while (Date.now() < end) {
    if (wanted.every((id) => app.services.sessions.get(id) !== undefined)) return true;
    await sleep(POLL_MS);
  }
  return false;
}

/** After the fleet is up: Jira connected for Orchard, the board, notes and pages seeded (once per database). */
export async function populateStepC(app: App, db: Db, jira: FakeJira, clock: () => Date): Promise<void> {
  if (!app.services.jira.sites().sites.some((site) => site.server === JIRA_OFFICE)) {
    await app.services.jira.connect(JIRA_OFFICE, jira.connectInput);
    setTimeout(() => {
      jira.touch('ORC-1101', 'Omar Khalil', 'Payments team confirmed: the fee must be added before the discount.');
      jira.touch('ORC-1115', 'Sara Haddad', 'Checked on the iPhone SE: the last line still wraps.');
    }, NEWS_DELAY_MS).unref();
  }
  await sessionsKnown(app);
  await seedStepC({ db, board: app.services.board, notes: app.services.notes, kb: app.services.kb, clock });
}
