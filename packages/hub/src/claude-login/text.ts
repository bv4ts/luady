import { isSelfHost, type HostId } from '@luady/shared';
import { clock12, ownerParts } from '../core/time.js';
import { ownerDateKey } from '../scheduler/zone.js';
import { managerName } from '@luady/shared';

const DAY_MS = 24 * 60 * 60_000;

/** "Luady" for the brain's own login, else the server name. */
export const hostLabel = (host: HostId): string => (isSelfHost(host) ? managerName() : host);

/** The command that signs this host in: plain /login for Luady. */
export const loginCommand = (host: HostId): string => (isSelfHost(host) ? '/login' : `/login ${host}`);

/** "a, b or c" (or "a, b and c"): a list of the fleet's own names in words. */
export function listWords(items: readonly string[], last: 'or' | 'and' = 'or'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${last} ${items.at(-1) ?? ''}`;
}

/** /login without a usable argument: the manager, each host of the fleet that can sign in, and ChatGPT. */
export function loginUsage(hosts: readonly HostId[]): string {
  const named = hosts.length === 0 ? '' : ` or /login ${listWords(hosts)}`;
  return `Usage: /login (signs ${managerName()} in)${named}; /login codex connects ChatGPT for images`;
}

/** A sign-in code with no sign-in waiting for it. */
export function noLoginWaiting(hosts: readonly HostId[]): string {
  return `No sign-in is waiting. Send /login first${hosts.length === 0 ? '' : ` (or /login ${hosts.join(', ')})`}.`;
}

/** "today 10:01 AM", "tomorrow 10:01 AM" or "Sun 10:01 AM" (owner time). */
export function whenText(at: Date, now: Date): string {
  const days = Math.round((Date.parse(ownerDateKey(at)) - Date.parse(ownerDateKey(now))) / DAY_MS);
  const day = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : ownerParts(at).weekday;
  return `${day} ${clock12(at)}`;
}

export function linkText(host: HostId, url: string): string {
  return [
    `🔐 *Sign in ${hostLabel(host)} to Claude*`,
    '1. Open this link and sign in with your Claude account:',
    url,
    '2. Tap *Authorize* and copy the code it shows.',
    '3. Send the code here (within 30 min).',
  ].join('\n');
}

export function signedInText(host: HostId, expiresAt: string | null, now: Date, restarted: boolean): string {
  const until = expiresAt === null ? '' : ` until ${whenText(new Date(expiresAt), now)}`;
  const after = !isSelfHost(host) ? 'Its sessions carry on.' : restarted ? `Restarting ${managerName()} now.` : `${managerName()} picks it up at its next restart.`;
  return `✅ *${hostLabel(host)} is signed in*${until}. ${after}`;
}

export function signInFailedText(host: HostId, message: string): string {
  return `❌ Sign-in failed: ${message}\nSend ${loginCommand(host)} to try again.`;
}

export function signedOutAlert(host: HostId): string {
  return isSelfHost(host)
    ? `🔴 *${managerName()} is signed out of Claude* and can't answer. Send /login to sign in.`
    : `🔴 *${host} is signed out of Claude*, so its sessions can't work. Send /login ${host} to sign in.`;
}

export function expiringAlert(host: HostId, expiresAt: Date, now: Date): string {
  return `🔴 *${hostLabel(host)}'s Claude login runs out ${whenText(expiresAt, now)}.* Send ${loginCommand(host)} to renew it now.`;
}

/** Answers of the data API (website and chat alike); none ever contains the code or the link. */
export const CODE_NOT_RECOGNISED = "That doesn't look like the sign-in code. Copy the whole code and send it again.";
export const TOO_MANY_TRIES = 'Too many tries. Start a new sign-in.';
export const NO_SIGN_IN_WAITING = 'No sign-in is waiting. Start a new sign-in.';
export const CODE_IN_FLIGHT = 'A code is already being checked for this sign-in. Wait for its answer.';

/** A sign-in link that is not https on the provider's own host is never shown. */
export const UNEXPECTED_LINK = 'The server returned an unexpected sign-in link';

/** Chat /login on a signed-in host while PIN confirmations are on: the owner replies with the PIN. */
export function signInPinText(host: HostId, actionId: string): string {
  return `🔐 ${hostLabel(host)} is signed in: a new sign-in can move it to another account. Reply to this message with your PIN to go on, or *no* to cancel. (#${actionId})`;
}

export const HELD_FIRST = `🔴 *${managerName()} is signed out of Claude.* Send /login to sign in; I'll pass this message on after that.`;
export const HELD_MORE = `Kept for ${managerName()} until you sign in (/login).`;
