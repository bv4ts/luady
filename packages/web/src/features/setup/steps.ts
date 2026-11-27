import type { SetupStateDTO, SetupStep } from '@luady/shared';

/** The page a login link opens (`luady login`); the token is in the fragment. */
export const LOGIN_LINK_PATH = '/setup/login';
export const SETUP_PATH = '/setup';

/** The wizard's screens: the five steps of the state machine before `done`, and the summary that finishes it. */
export type SetupScreen = Exclude<SetupStep, 'done'> | 'open';
/** The screens that live inside the signed-in app (they need the store, the PIN prompt and the live socket). */
export type WizardScreen = 'rooms' | 'connect' | 'extras' | 'open';

export interface ScreenInfo {
  readonly id: SetupScreen;
  /** One or two plain words for the step list. */
  readonly label: string;
}

export const SCREENS: readonly ScreenInfo[] = Object.freeze([
  { id: 'claim', label: 'Claim' },
  { id: 'pin', label: 'PIN' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'connect', label: 'Connect' },
  { id: 'extras', label: 'Extras' },
  { id: 'open', label: 'Open' },
]);

const WIZARD: readonly WizardScreen[] = ['rooms', 'connect', 'extras', 'open'];

export function isWizardScreen(value: string | undefined): value is WizardScreen {
  return value !== undefined && (WIZARD as readonly string[]).includes(value);
}

export function screenIndex(screen: SetupScreen): number {
  return SCREENS.findIndex((info) => info.id === screen);
}

/** The screen a state stands on: `extras` is the furthest the hub stores before `done`; `open` is its summary. */
export function screenOf(state: SetupStateDTO): SetupScreen | null {
  return state.step === 'done' ? null : state.step;
}

/** Whether a state's step lives in the signed-in app (after the PIN, before done). */
export function inWizard(state: SetupStateDTO | null): state is SetupStateDTO & { step: 'rooms' | 'connect' | 'extras' } {
  return state !== null && (state.step === 'rooms' || state.step === 'connect' || state.step === 'extras');
}

/**
 * Which wizard screen to show for an address: one already reached may be seen again; one ahead of the state is not
 * (the summary `open` is reached with `extras`).
 */
export function allowedScreen(state: SetupStateDTO, asked: string | undefined): WizardScreen | null {
  if (!inWizard(state)) return null;
  if (!isWizardScreen(asked)) return state.step;
  const reach = state.step === 'extras' ? screenIndex('open') : screenIndex(state.step);
  return screenIndex(asked) <= reach ? asked : state.step;
}

export function wizardPath(screen: WizardScreen): string {
  return `${SETUP_PATH}/${screen}`;
}

/** Plain words for the summary: what was skipped, as the step list names it. */
export function skippedLabels(state: SetupStateDTO): string[] {
  return state.skipped.map((step) => (step === 'passkey' ? 'Passkey' : SCREENS.find((info) => info.id === step)?.label ?? step));
}

/**
 * The summary's line on time: the zone the claim stored (this browser's), or, while none is stored, the zone the page
 * uses instead.
 */
export function zoneLine(stored: string | null, browser: string | null): string {
  if (stored !== null) return `Times are shown in ${stored}. You can change this in Settings.`;
  if (browser !== null) return `Times are shown in this browser's time zone (${browser}) until you save one in Settings.`;
  return 'Times are shown in UTC until you choose your time zone in Settings.';
}
