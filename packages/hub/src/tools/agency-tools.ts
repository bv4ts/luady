import type { PresenceDTO, ToolName } from '@luady/shared';
import type { ToolHandler } from '../core/contracts.js';
import { clock12 } from '../core/time.js';
import { defineTool, formatActionResult, requestAsLuady } from './common.js';
import { resolveSession } from './session-tools.js';

export const NO_LIMITS_SERVICE = 'Account limits are not available.';
export const PRESENCE_HERE = 'The owner is on the website: updates show on their screen first, and go to their chat channel (when one is connected) if not seen or answered after 10 minutes.';
export const PRESENCE_CLOSED = 'The website is closed: updates go to their chat channel at once (with none connected, they wait on the website).';
export const PRESENCE_AWAY = 'The owner set /away: updates go to their chat channel at once.';

/** One sentence for `owner_presence`; times are owner time. */
export function presenceText(state: PresenceDTO): string {
  if (state.forcedUntil !== null) return `The owner asked for updates on their chat channel until ${clock12(new Date(state.forcedUntil))}.`;
  if (state.mode === 'here') return PRESENCE_HERE;
  // The chat while a tab is fresh and no forced hour runs: only /away does that (notices/presence.ts).
  return state.online ? PRESENCE_AWAY : PRESENCE_CLOSED;
}

/** Limits, pause and resume, and where the owner is (the agency skill tells Luady when to use them). */
export const AGENCY_TOOLS = {
  account_limits: defineTool('account_limits', async (_args, ctx) =>
    ctx.accounts === undefined ? NO_LIMITS_SERVICE : ctx.accounts.limitsText()),
  session_pause: defineTool('session_pause', async (args, ctx) => {
    const session = resolveSession(args.session, ctx);
    return formatActionResult(await requestAsLuady(ctx, 'session.pause', { sessionId: session.id }));
  }),
  session_resume: defineTool('session_resume', async (args, ctx) => {
    const session = resolveSession(args.session, ctx);
    return formatActionResult(await requestAsLuady(ctx, 'session.resume', { sessionId: session.id }));
  }),
  owner_presence: defineTool('owner_presence', async (_args, ctx) =>
    ctx.presence === undefined ? PRESENCE_CLOSED : presenceText(ctx.presence.state())),
} satisfies Partial<Record<ToolName, ToolHandler>>;
