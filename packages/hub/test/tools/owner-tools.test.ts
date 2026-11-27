import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@luady/shared';
import { NotFoundError } from '../../src/core/errors.js';
import { OWNER_TOOLS } from '../../src/tools/owner-tools.js';
import { createFakeToolContext } from './fake-context.js';

const URGENT_CASES = [
  { name: 'the phone service and setting both on', service: true, setting: true, calls: 1 },
  { name: 'the phone setting off', service: true, setting: false, calls: 0 },
  { name: 'the phone service off', service: false, setting: true, calls: 0 },
];

describe('owner tools', () => {
  it('notify_user sends a chat message', async () => {
    const ctx = createFakeToolContext();
    await expect(OWNER_TOOLS.notify_user({ text: 'Build finished' }, ctx)).resolves.toBe('Message sent.');
    expect(ctx.outbound.send).toHaveBeenCalledWith('Build finished', null);
    expect(ctx.phone.callOwner).not.toHaveBeenCalled();
  });

  it('notify_user reports a queued message only when the chat really queued it', async () => {
    const ctx = createFakeToolContext();
    vi.mocked(ctx.outbound.send).mockResolvedValue(null);
    await expect(OWNER_TOOLS.notify_user({ text: 'later' }, ctx)).resolves.toBe('Message queued (the chat is offline).');
    const notices = { ...ctx, outbound: { ...ctx.outbound, deliver: vi.fn(async () => ({ msgId: null, held: false })) } };
    await expect(OWNER_TOOLS.notify_user({ text: 'later' }, notices)).resolves.toBe('Message queued (the chat is offline).');
  });

  it('notify_user tells Luady the truth when the text waits on the website', async () => {
    const deliver = vi.fn(async () => ({ msgId: null, held: true }));
    const ctx = createFakeToolContext();
    const held = { ...ctx, outbound: { ...ctx.outbound, deliver } };
    await expect(OWNER_TOOLS.notify_user({ text: 'Build finished' }, held)).resolves.toBe(
      'Shown on the website. If the owner has not seen it in 10 minutes and a chat channel is connected, it goes there too.',
    );
    expect(deliver).toHaveBeenCalledWith('Build finished', null, { urgent: false });
  });

  it.for(URGENT_CASES)('urgent notify_user calls only with $name', async ({ service, setting, calls }) => {
    const ctx = createFakeToolContext();
    vi.mocked(ctx.phone.enabled).mockReturnValue(service);
    vi.mocked(ctx.settings.get).mockReturnValue({ ...DEFAULT_SETTINGS, phone_enabled: setting });
    const text = await OWNER_TOOLS.notify_user({ text: 'Server cedar is down', urgent: true }, ctx);
    expect(ctx.phone.callOwner).toHaveBeenCalledTimes(calls);
    expect(text).toBe(calls === 1 ? 'Message sent; calling the owner now.' : 'Message sent.');
  });

  it('call_user says the phone is not enabled yet', async () => {
    const ctx = createFakeToolContext();
    await expect(OWNER_TOOLS.call_user({ reason: 'question waiting' }, ctx)).resolves.toBe('Phone is not enabled yet.');
    expect(ctx.phone.callOwner).not.toHaveBeenCalled();
  });

  it('call_user phones the owner when the phone is enabled', async () => {
    const ctx = createFakeToolContext();
    vi.mocked(ctx.phone.enabled).mockReturnValue(true);
    vi.mocked(ctx.settings.get).mockReturnValue({ ...DEFAULT_SETTINGS, phone_enabled: true });
    await expect(OWNER_TOOLS.call_user({ reason: 'question waiting' }, ctx)).resolves.toBe('Calling the owner now.');
    expect(ctx.phone.callOwner).toHaveBeenCalledWith('question waiting');
  });

  it('schedule, schedule_list and schedule_cancel use the scheduler', async () => {
    const ctx = createFakeToolContext();
    vi.mocked(ctx.scheduler.add).mockReturnValue({ id: 'S1', when: '0 9 * * 1', task: 'weekly report', nextRunAt: '2026-10-12T05:00:00.000Z' });
    await expect(OWNER_TOOLS.schedule({ when: '0 9 * * 1', task: 'weekly report' }, ctx)).resolves.toBe(
      'Scheduled S1 (0 9 * * 1); next run 2026-10-12T05:00:00.000Z.',
    );
    expect(ctx.scheduler.add).toHaveBeenCalledWith('0 9 * * 1', 'weekly report');
    await expect(OWNER_TOOLS.schedule_list({}, ctx)).resolves.toBe('No scheduled tasks.');
    vi.mocked(ctx.scheduler.list).mockReturnValue([{ id: 'S1', when: '0 9 * * 1', task: 'weekly report', nextRunAt: null }]);
    await expect(OWNER_TOOLS.schedule_list({}, ctx)).resolves.toBe('- S1 · 0 9 * * 1 · next — · weekly report');
    vi.mocked(ctx.scheduler.cancel).mockReturnValueOnce(true);
    await expect(OWNER_TOOLS.schedule_cancel({ id: 'S1' }, ctx)).resolves.toBe('Cancelled S1.');
    await expect(OWNER_TOOLS.schedule_cancel({ id: 'S2' }, ctx)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('image_generate passes defaulted references on and returns the id, the future path and how to edit it next', async () => {
    const ctx = createFakeToolContext();
    const path = '/home/luady/brain/inbox/images/img-1a2b3c4d/image-1.png';
    const start = vi.fn(() => ({ id: 'img-1a2b3c4d', path }));
    ctx.images = { start };
    const text = await OWNER_TOOLS.image_generate({ prompt: 'make the sky purple', references: [{ source: 'img-00000000', role: 'edit' }] }, ctx);
    expect(start).toHaveBeenCalledWith('make the sky purple', {
      references: [{ source: 'img-00000000', role: 'edit', note: '' }], transparent: false, deliver: 'owner', caption: '',
    });
    expect(text).toBe(`Image img-1a2b3c4d started in the background (1–2 min); it reaches the owner by itself (their chat, or the website while no chat channel is up). When done it is ${path} — for a follow-up change pass {source:"img-1a2b3c4d", role:"edit"}. Don't poll it.`);
    const luady = await OWNER_TOOLS.image_generate({ prompt: 'a logo', deliver: 'manager' }, ctx);
    expect(luady).toContain(`the owner gets nothing — its path (${path}) arrives in an Event`);
  });
});
