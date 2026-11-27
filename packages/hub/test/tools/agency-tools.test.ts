import { describe, expect, it, vi } from 'vitest';
import type { PresenceDTO } from '@luady/shared';
import type { ToolContext } from '../../src/core/contracts.js';
import { AGENCY_TOOLS, presenceText } from '../../src/tools/agency-tools.js';
import { SID, createFakeToolContext, makeAction, makeSession } from './fake-context.js';

function withSessions(): ToolContext {
  const ctx = createFakeToolContext();
  vi.mocked(ctx.sessions.findByRef).mockImplementation((ref) => (ref === 'cedar/meadow-hr' || ref === SID ? makeSession() : undefined));
  vi.mocked(ctx.sessions.list).mockReturnValue([makeSession()]);
  return ctx;
}

const HERE: PresenceDTO = { mode: 'here', online: true, clients: 1, forcedUntil: null };

describe('account_limits', () => {
  it('passes the limits text through', async () => {
    const ctx = { ...createFakeToolContext(), accounts: { limitsText: vi.fn(async () => 'Max (cedar) · 5h 62% (resets 3:20 PM) · week 41% (resets Mon 9:00 AM)') } };
    await expect(AGENCY_TOOLS.account_limits({}, ctx)).resolves.toBe('Max (cedar) · 5h 62% (resets 3:20 PM) · week 41% (resets Mon 9:00 AM)');
  });

  it('says so when the hub has no accounts service', async () => {
    await expect(AGENCY_TOOLS.account_limits({}, createFakeToolContext())).resolves.toBe('Account limits are not available.');
  });
});

describe('session_pause and session_resume', () => {
  it('pause requests session.pause as Luady', async () => {
    const ctx = withSessions();
    vi.mocked(ctx.actions.request).mockResolvedValue(makeAction({ kind: 'session.pause', tier: 0, status: 'done', result: 'paused' }));
    await expect(AGENCY_TOOLS.session_pause({ session: 'cedar/meadow-hr' }, ctx)).resolves.toBe('done: action A7 — paused');
    expect(ctx.actions.request).toHaveBeenCalledWith({ kind: 'session.pause', actor: 'manager', channel: 'event', params: { sessionId: SID } });
  });

  it('resume requests session.resume as Luady', async () => {
    const ctx = withSessions();
    vi.mocked(ctx.actions.request).mockResolvedValue(makeAction({ kind: 'session.resume', tier: 0, status: 'done', result: 'resumed' }));
    await expect(AGENCY_TOOLS.session_resume({ session: SID }, ctx)).resolves.toBe('done: action A7 — resumed');
    expect(ctx.actions.request).toHaveBeenCalledWith({ kind: 'session.resume', actor: 'manager', channel: 'event', params: { sessionId: SID } });
  });

  it('an unknown session gives the existing "Unknown session" text and requests nothing', async () => {
    const ctx = withSessions();
    await expect(AGENCY_TOOLS.session_pause({ session: 'nope' }, ctx)).rejects.toThrow('Unknown session "nope"');
    await expect(AGENCY_TOOLS.session_resume({ session: 'nope' }, ctx)).rejects.toThrow('Unknown session "nope"');
    expect(ctx.actions.request).not.toHaveBeenCalled();
  });
});

describe('owner_presence', () => {
  it('the owner is on the website', async () => {
    const ctx = { ...createFakeToolContext(), presence: { state: () => HERE } };
    await expect(AGENCY_TOOLS.owner_presence({}, ctx)).resolves.toBe(
      'The owner is on the website: updates show on their screen first, and go to their chat channel (when one is connected) if not seen or answered after 10 minutes.',
    );
  });

  it('the website is closed', () => {
    expect(presenceText({ mode: 'chat', online: false, clients: 0, forcedUntil: null })).toBe('The website is closed: updates go to their chat channel at once (with none connected, they wait on the website).');
  });

  it('the owner asked for the chat until a time (owner time)', () => {
    expect(presenceText({ mode: 'chat', online: true, clients: 1, forcedUntil: '2026-11-14T11:20:00.000Z' })).toBe('The owner asked for updates on their chat channel until 3:20 PM.');
  });

  it('the owner is away (/away) while a tab is open', () => {
    expect(presenceText({ mode: 'chat', online: true, clients: 1, forcedUntil: null })).toBe('The owner set /away: updates go to their chat channel at once.');
  });

  it('without the presence service, updates go to the chat', async () => {
    await expect(AGENCY_TOOLS.owner_presence({}, createFakeToolContext())).resolves.toBe('The website is closed: updates go to their chat channel at once (with none connected, they wait on the website).');
  });
});
