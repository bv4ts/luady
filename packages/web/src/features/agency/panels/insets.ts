import type { StageInsets } from '../stage-types.js';

/** Must match agency.css (--agency-topbar-h, --agency-chat-h, --agency-dock-w) and panels.css. */
export const TOP_BAR_PX = 56;
/** On a phone the room chips get a second row of their own under the brand and the bell. */
export const PHONE_TOP_BAR_PX = 100;
export const CHAT_LINE_PX = 64;
export const DOCK_PX = 360;
/** The phone sheet covers this share of the height, chat line included. */
export const SHEET_RATIO = 0.56;
/** Below this width panels are bottom sheets. */
export const PHONE_BELOW_PX = 760;

export type PanelMode = 'dock' | 'sheet';

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export function panelMode(width: number): PanelMode {
  return width >= PHONE_BELOW_PX ? 'dock' : 'sheet';
}

/**
 * The parts of the stage the HUD covers, so the camera keeps what matters in the free area:
 * the top bar and the chat line, plus the dock on the right or the sheet at the bottom while a panel is open.
 * The sheet is drawn over the chat line, so on a phone it replaces the chat line's inset.
 */
export function stageInsets(viewport: Viewport, panelOpen: boolean): StageInsets {
  const phone = panelMode(viewport.width) === 'sheet';
  const base: StageInsets = { top: phone ? PHONE_TOP_BAR_PX : TOP_BAR_PX, right: 0, bottom: CHAT_LINE_PX, left: 0 };
  if (!panelOpen) return base;
  if (!phone) return { ...base, right: DOCK_PX };
  return { ...base, bottom: Math.max(CHAT_LINE_PX, Math.round(viewport.height * SHEET_RATIO)) };
}
