import { describe, expect, it, vi } from 'vitest';
import { PinInvalidError } from '../../src/core/errors.js';
import { createBus } from '../../src/core/bus.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createSettingsService } from '../../src/settings/service.js';
import { call, harnessFactory } from './helpers.js';

const harness = harnessFactory();

describe('PUT /api/settings and the PIN rule', () => {
  it('turning require_pin off without the PIN answers 428 pin_required and changes nothing', async () => {
    const h = await harness();
    const session = h.login();
    const res = await call(h, 'PUT', '/api/settings', { require_pin: false }, { session });
    expect(res.statusCode).toBe(428);
    expect(res.json()).toMatchObject({ error: { code: 'pin_required' } });
    expect(h.deps.settings.update).not.toHaveBeenCalled();
  });

  it('a wrong PIN is refused by the PIN service (with its lockout) before anything is written', async () => {
    const h = await harness();
    vi.mocked(h.deps.pin.verify).mockRejectedValue(new PinInvalidError(2));
    const res = await call(h, 'PUT', '/api/settings', { require_pin: false, pin: '000000' }, { session: h.login() });
    expect(res.statusCode).toBe(403);
    expect(h.deps.pin.verify).toHaveBeenCalledWith('000000', 'web');
    expect(h.deps.settings.update).not.toHaveBeenCalled();
  });

  it('the right PIN turns it off; the PIN itself is never handed on to be stored', async () => {
    const h = await harness();
    const res = await call(h, 'PUT', '/api/settings', { require_pin: false, pin: '135790' }, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(h.deps.settings.update).toHaveBeenCalledWith({ require_pin: false });
  });

  it('other changes, and turning require_pin back on, need no PIN', async () => {
    const h = await harness();
    expect((await call(h, 'PUT', '/api/settings', { require_pin: true, digest_enabled: true }, { session: h.login() })).statusCode).toBe(200);
    expect(h.deps.pin.verify).not.toHaveBeenCalled();
  });

  it('the settings service never stores a pin field, even if one reaches it', () => {
    const db = openMemoryDb();
    const settings = createSettingsService({ db, bus: createBus() });
    settings.update({ require_pin: false, pin: '135790' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'pin'").get()).toEqual({ n: 0 });
    expect(JSON.stringify(db.prepare('SELECT value_json FROM settings').all())).not.toContain('135790');
  });
});
