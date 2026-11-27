/** Why the office handed over to the classic view; travels as router location state to /inbox. */
export interface OfficeFallbackState {
  readonly officeFallback: string;
}

/** The stage's reason when the browser has no WebGL (`createStageApp`). */
export const WEBGL_UNAVAILABLE = 'webgl-unavailable';

export const CLASSIC_PATH = '/inbox';

export function officeFallbackState(reason: string): OfficeFallbackState {
  return { officeFallback: reason };
}

/** The one-line notice for the classic view, or null when the office did not hand over. */
export function officeNoticeText(locationState: unknown): string | null {
  if (typeof locationState !== 'object' || locationState === null || !('officeFallback' in locationState)) return null;
  return locationState.officeFallback === WEBGL_UNAVAILABLE
    ? 'The office view needs WebGL, which this browser does not offer. Showing the classic view.'
    : 'The office view could not start. Showing the classic view.';
}
