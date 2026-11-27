import {
  SKIPPABLE_SETUP_STEPS, type SetupStateDTO, type SetupStep, type SkippableSetupStep,
} from '@luady/shared';
import { authModeOf } from '../config/defaults.js';
import { isRemote } from '../config/remote.js';
import type { Clock, Db, EventBus, HubConfig, Logger } from '../core/contracts.js';
import { RefusedError } from '../core/errors.js';
import { isoNow } from '../core/time.js';

/**
 * The first-run state: claim → pin → rooms → connect → extras → done.
 *
 * Everything it is made of lives in the database (the passkeys, the PIN's hash, the `setup_state` row), so the hub and
 * the CLI (`luady start`, before or after the hub listens) read the same state.
 *
 * - **Claimed** means an owner exists: a passkey, a PIN, or a finished setup. A login link alone never claims an install:
 *   after a passkey skip the install stays unclaimed until the first PIN is set, which needs the setup code.
 * - The step is `claim` while there is no owner and the passkey was not skipped, `pin` while no PIN is set, and after
 *   that the row's step.
 */

/** The config fields the state reads. */
export type SetupConfig = Pick<HubConfig, 'publicOrigin'> & Partial<Pick<HubConfig, 'bindHost' | 'allowedHosts' | 'authMode'>>;

/** The three steps after the PIN, in order; the row stores one of them, or `done`. */
export const WIZARD_STEPS = ['rooms', 'connect', 'extras'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface SetupRow {
  readonly step: string;
  readonly skipped: readonly SkippableSetupStep[];
}

export interface SetupFacts {
  readonly passkeys: number;
  readonly pinSet: boolean;
  readonly row: SetupRow;
}

/** Who asks for a step change: whether the session came from a login link, and whether the request is local. */
export interface StepActor {
  readonly linkSession: boolean;
  /** No proxy in between, a loopback peer, a non-remote install (web/auth/login-link.ts). */
  readonly localRequest: boolean;
}

export interface SetupStateService {
  state(): SetupStateDTO;
  advance(step: SkippableSetupStep, action: 'done' | 'skip', who: StepActor): SetupStateDTO;
  finish(): SetupStateDTO;
  /** Sends `setup.changed` when the state differs from the last one sent (a passkey or PIN set elsewhere). */
  notify(): void;
}

export interface SetupStateDeps {
  db: Db;
  bus: EventBus;
  clock: Clock;
  config: SetupConfig;
  log: Logger;
}

const isWizardStep = (value: string): value is WizardStep => (WIZARD_STEPS as readonly string[]).includes(value);
const isSkippable = (value: unknown): value is SkippableSetupStep => (SKIPPABLE_SETUP_STEPS as readonly unknown[]).includes(value);

/** The stored skip list, read defensively: unknown or repeated entries are dropped, unreadable JSON is empty. */
export function parseSkipped(json: string): SkippableSetupStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return SKIPPABLE_SETUP_STEPS.filter((step) => parsed.some((entry: unknown) => entry === step && isSkippable(entry)));
}

/** In the order of SKIPPABLE_SETUP_STEPS, each once. */
function normalised(steps: readonly SkippableSetupStep[]): SkippableSetupStep[] {
  return SKIPPABLE_SETUP_STEPS.filter((step) => steps.includes(step));
}

/** A reader of the facts with its statements prepared once (the state is read by an anonymous route). */
export function factsReader(db: Db): () => SetupFacts {
  const rowOf = db.prepare<[], { step: string; skipped_json: string }>('SELECT step, skipped_json FROM setup_state WHERE id = 1');
  const passkeysOf = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM auth_passkeys');
  const pinOf = db.prepare<[], { set: number }>('SELECT hash IS NOT NULL AS "set" FROM pin_state WHERE id = 1');
  return () => {
    const row = rowOf.get();
    if (row === undefined) throw new Error('setup_state row is missing; run migrations');
    const passkeys = passkeysOf.get()?.n ?? 0;
    return { passkeys, pinSet: pinOf.get()?.set === 1, row: { step: row.step, skipped: parseSkipped(row.skipped_json) } };
  };
}

/** The facts read once (the CLI's commands). */
export function readFacts(db: Db): SetupFacts {
  return factsReader(db)();
}

/** Setup is pending while there is no owner yet or no PIN: the hub then answers only sign-in and setup. */
export function setupPending(state: Pick<SetupStateDTO, 'step'>): boolean {
  return state.step === 'claim' || state.step === 'pin';
}

export function claimedOf(facts: SetupFacts): boolean {
  return facts.passkeys > 0 || facts.pinSet || facts.row.step === 'done';
}

export function stepOf(facts: SetupFacts): SetupStep {
  const done = facts.row.step === 'done';
  if (!facts.pinSet) {
    const pastClaim = facts.passkeys > 0 || done || facts.row.skipped.includes('passkey');
    return pastClaim ? 'pin' : 'claim';
  }
  if (done) return 'done';
  return isWizardStep(facts.row.step) ? facts.row.step : 'rooms';
}

/** The five fields of the DTO and nothing else: what an anonymous visitor may know. */
export function stateOf(facts: SetupFacts, config: SetupConfig): SetupStateDTO {
  // A passkey made after a skip ends the skip: the list says what is still missing.
  const skipped = facts.passkeys > 0 ? facts.row.skipped.filter((step) => step !== 'passkey') : [...facts.row.skipped];
  return { step: stepOf(facts), claimed: claimedOf(facts), authMode: authModeOf(config), remote: isRemote(config), skipped };
}

/**
 * Why a passkey skip must be refused, in plain words, or null: only a login-link session may skip, only on a
 * non-remote install, and only from this computer without a proxy in between.
 */
export function passkeySkipRefusal(who: StepActor, config: SetupConfig): string | null {
  if (isRemote(config)) return 'This hub can be reached from other machines, so a passkey is required.';
  if (!who.localRequest) return 'Skipping the passkey works only on the computer Luady runs on, opened at http://localhost.';
  if (!who.linkSession) return 'Skipping the passkey needs a login link: run npm run luady -- login in the terminal where Luady runs.';
  return null;
}

function wizardIndex(step: SetupStep): number {
  return isWizardStep(step) ? WIZARD_STEPS.indexOf(step) : -1;
}

function nextWizardStep(step: WizardStep): WizardStep {
  return WIZARD_STEPS[Math.min(WIZARD_STEPS.indexOf(step) + 1, WIZARD_STEPS.length - 1)] ?? step;
}

const PIN_FIRST = 'Claim this install and choose a PIN first.';

export function createSetupState(deps: SetupStateDeps): SetupStateService {
  const { db, bus, clock, config, log } = deps;
  const readNow = factsReader(db);
  // `completed_at` is set when the row first becomes `done` and kept after that; it is empty before.
  const write = db.prepare<[{ step: string; skipped: string; now: string }]>(
    `UPDATE setup_state SET step = @step, skipped_json = @skipped, updated_at = @now,
       completed_at = CASE WHEN @step = 'done' THEN COALESCE(completed_at, @now) ELSE NULL END WHERE id = 1`,
  );
  const current = (): SetupStateDTO => stateOf(readNow(), config);
  // What the website last heard; the state at start counts as heard (every page reads it on load).
  let lastSent: string = JSON.stringify(current());

  function send(state: SetupStateDTO): SetupStateDTO {
    const text = JSON.stringify(state);
    if (text !== lastSent) {
      lastSent = text;
      bus.emit('setup.changed', { state });
    }
    return state;
  }

  function store(step: string, skipped: readonly SkippableSetupStep[]): SetupStateDTO {
    write.run({ step, skipped: JSON.stringify(normalised(skipped)), now: isoNow(clock) });
    return send(current());
  }

  function passkeyStep(action: 'done' | 'skip', who: StepActor): SetupStateDTO {
    const facts = readNow();
    if (action === 'done') {
      if (facts.passkeys === 0) throw new RefusedError('No passkey is registered yet.');
      return send(current());
    }
    const refusal = passkeySkipRefusal(who, config);
    if (refusal !== null) throw new RefusedError(refusal);
    if (facts.passkeys > 0) throw new RefusedError('This install already has a passkey.');
    log.info('setup: passkey skipped with a login link');
    return store(facts.row.step, [...facts.row.skipped, 'passkey']);
  }

  function wizardStep(step: WizardStep, action: 'done' | 'skip'): SetupStateDTO {
    const facts = readNow();
    const now = stepOf(facts);
    if (now === 'claim' || now === 'pin') throw new RefusedError(PIN_FIRST);
    const at = wizardIndex(now);
    const asked = WIZARD_STEPS.indexOf(step);
    const others = facts.row.skipped.filter((entry) => entry !== step);
    // An earlier step (or any step once setup is done) shown again: the state only moves forward, and a "done" there
    // clears that step's earlier skip.
    if (now === 'done' || asked < at) {
      if (action === 'skip' || others.length === facts.row.skipped.length) return send(current());
      return store(facts.row.step, others);
    }
    if (asked > at) throw new RefusedError(`Finish the ${now} step first.`);
    return store(nextWizardStep(step), action === 'skip' ? [...others, step] : others);
  }

  return {
    state: current,
    advance(step, action, who) {
      return step === 'passkey' ? passkeyStep(action, who) : wizardStep(step, action);
    },
    finish() {
      const facts = readNow();
      const now = stepOf(facts);
      if (now === 'done') return send(current());
      if (now === 'claim' || now === 'pin') throw new RefusedError(PIN_FIRST);
      // Steps never reached count as skipped, so the list stays honest.
      const unreached = WIZARD_STEPS.slice(wizardIndex(now) + (now === 'extras' ? 1 : 0));
      log.info('setup: finished');
      return store('done', [...facts.row.skipped, ...unreached]);
    },
    notify() {
      send(current());
    },
  };
}
