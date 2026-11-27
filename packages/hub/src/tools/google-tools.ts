import type { ToolName } from '@luady/shared';
import type { ToolContext, ToolHandler } from '../core/contracts.js';
import { NotFoundError, RefusedError } from '../core/errors.js';
import { defineTool } from './common.js';

function google(ctx: ToolContext): NonNullable<ToolContext['google']> {
  if (ctx.google === undefined || ctx.google === null) throw new RefusedError('Gmail and Calendar are not set up yet.');
  return ctx.google;
}

/** The IMAP mailbox answers to its label, its address, its domain or plain "imap". */
const isImap = (ctx: ToolContext, account: string | undefined): boolean => {
  if (ctx.imap == null || account === undefined) return false;
  const wanted = account.trim().toLowerCase();
  const user = ctx.imap.user.toLowerCase();
  return [ctx.imap.label, user, user.split('@')[1], 'imap'].includes(wanted);
};

/** First line of every search, so Luady always knows which mailboxes exist (and never says one is missing). */
export function mailboxesLine(ctx: ToolContext): string {
  const list = (ctx.google?.accounts() ?? []).filter((a) => a.mail).map((a) => `${a.label} (Gmail, ${a.email})`);
  if (ctx.imap != null) list.push(`${ctx.imap.label} (${ctx.imap.user}, IMAP)`);
  return `Mailboxes: ${list.join(', ') || 'none'}`;
}

async function searchImap(ctx: ToolContext, query: string, limit: number): Promise<string> {
  const imap = ctx.imap!;
  try {
    return (await imap.search(query, limit)).join('\n') || `- [${imap.label}] no match`;
  } catch (err) {
    return `- [${imap.label}] could not be searched right now: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const GOOGLE_TOOLS = {
  email_search: defineTool('email_search', async (args, ctx) => {
    const head = mailboxesLine(ctx);
    if (isImap(ctx, args.account)) return `${head}\n${await searchImap(ctx, args.query, args.limit)}`;
    const hasGoogle = ctx.google != null && ctx.google.accounts().length > 0;
    if (!hasGoogle && ctx.imap == null) throw new RefusedError('No mailbox is connected yet. Send /google to connect Gmail.');
    const parts = [head];
    if (hasGoogle) {
      try {
        parts.push(await ctx.google!.search(args.query, args.account, args.limit));
      } catch (err) {
        if (err instanceof NotFoundError) throw new NotFoundError(`No mailbox "${args.account}". ${head}`);
        throw err;
      }
    }
    if (ctx.imap != null && args.account === undefined) parts.push(await searchImap(ctx, args.query, args.limit));
    return parts.join('\n');
  }),
  email_read: defineTool('email_read', async (args, ctx) => {
    if (args.id.startsWith('imap:')) {
      if (ctx.imap == null) throw new RefusedError('The IMAP mailbox is not set up.');
      return ctx.imap.read(args.id);
    }
    return google(ctx).read(args.id, args.account);
  }),
  calendar_events: defineTool('calendar_events', async (args, ctx) => google(ctx).events(args.days, args.account)),
} satisfies Partial<Record<ToolName, ToolHandler>>;
