import { describe, expect, it } from 'vitest';
import { DEFAULT_WEB_PREFS } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { openMemoryDb } from '../../src/db/open.js';
import { PREFS_KEY, createPrefsService } from '../../src/prefs/index.js';
import { createSettingsService } from '../../src/settings/service.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';

function setup() {
  const db = openMemoryDb();
  const bus = createBus();
  const changed: string[] = [];
  bus.on('prefs.changed', ({ at }) => changed.push(at));
  const prefs = createPrefsService({ db, bus, clock: createFakeClock('2026-11-15T12:00:00.000Z'), log: silentLogger() });
  return { db, bus, prefs, changed };
}

describe('website preferences', () => {
  it('the defaults until changed; a change merges, is stored and announced once', async () => {
    const t = setup();
    expect(t.prefs.get()).toEqual(DEFAULT_WEB_PREFS);
    expect(await t.prefs.update({ sound: { muted: true } })).toEqual({ sound: { muted: true, volume: 0.6 }, dayNight: true });
    expect(await t.prefs.update({ sound: { volume: 0.2 }, dayNight: false })).toEqual({ sound: { muted: true, volume: 0.2 }, dayNight: false });
    expect(await t.prefs.update({ dayNight: false })).toEqual({ sound: { muted: true, volume: 0.2 }, dayNight: false });
    expect(t.changed).toEqual(['2026-11-15T12:00:00.000Z', '2026-11-15T12:00:00.000Z']);
    expect(t.prefs.get()).toEqual({ sound: { muted: true, volume: 0.2 }, dayNight: false });
  });

  it('a stored row that does not parse reads as the defaults; the settings service ignores the row', async () => {
    const t = setup();
    t.db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(PREFS_KEY, '{"sound":{"muted":"yes"}}');
    expect(t.prefs.get()).toEqual(DEFAULT_WEB_PREFS);
    t.db.prepare('UPDATE settings SET value_json = ? WHERE key = ?').run('not json', PREFS_KEY);
    expect(t.prefs.get()).toEqual(DEFAULT_WEB_PREFS);
    await t.prefs.update({ dayNight: false });
    const settings = createSettingsService({ db: t.db, bus: t.bus });
    expect(settings.get()).not.toHaveProperty(PREFS_KEY);
  });
});
