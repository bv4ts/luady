import { LIMITS, isChatChannel, type Channel, type NoticeKind } from '@luady/shared';

/** Where the thing being answered came from: the owner's chat channel, the website, or 'hub' (the manager or the hub started it). */
export type NoticeSource = 'chat' | 'web' | 'hub';

export interface RouteInput {
  readonly kind: NoticeKind;
  readonly source: NoticeSource;
  readonly mode: 'here' | 'chat';
  readonly forced: boolean;
  /** Time-critical (a calendar reminder, a sign-in alert, notify_user urgent): never held on the website. */
  readonly urgent?: boolean;
}

/** Exactly one chat path: `chatNow`, or a fallback after `fallbackMs`. `store` = keep it as a notice. */
export interface Route { readonly chatNow: boolean; readonly fallbackMs: number | null; readonly store: boolean }

const NOW_UNSTORED: Route = { chatNow: true, fallbackMs: null, store: false };
const NOW: Route = { chatNow: true, fallbackMs: null, store: true };
const WEBSITE_FIRST: Route = { chatNow: false, fallbackMs: LIMITS.noticeFallbackMs, store: true };

/** First matching row. Quiet hours and mute are decided by the callers. */
export function routeFor(input: RouteInput): Route {
  if (input.source === 'chat') return NOW_UNSTORED; // reply to a chat message
  if (input.kind === 'morning') return NOW; // the morning message: the chat always, and the website
  if (input.urgent === true) return NOW; // time-critical: the chat at once (the caller already applied quiet hours)
  if (input.forced) return NOW; // the owner pressed "Updates: chat"
  if (input.source === 'web') return WEBSITE_FIRST; // reply to a website message
  if (input.mode === 'here') return WEBSITE_FIRST; // a manager-started update, question or permission, website on
  return NOW; // a manager-started update, website off
}

/** A chat channel and the phone → 'chat'; web → 'web'; Event, Scheduled, Remote Control and no source → 'hub'. */
export function sourceOfChannel(channel: Channel | null): NoticeSource {
  if (channel === 'phone' || isChatChannel(channel)) return 'chat';
  if (channel === 'web') return 'web';
  return 'hub';
}

/** Questions and permissions settle when answered (on any channel), everything else when seen. */
export function settlesOnAnswer(kind: NoticeKind): boolean {
  return kind === 'question' || kind === 'permission';
}

/** A fallback that falls in quiet hours waits for the morning, except a red question or permission. */
export function fallbackWaitsForMorning(kind: NoticeKind): boolean {
  return !settlesOnAnswer(kind);
}
