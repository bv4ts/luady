import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { ValidationError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createSettingsService } from '../../src/settings/service.js';

function setup() {
  const db = openMemoryDb();
  const bus = createBus();
  const events: Settings[] = [];
  bus.on('settings.updated', (settings) => {
    events.push(settings);
  });
  return { db, bus, events, service: createSettingsService({ db, bus }) };
}

function rowCount(db: ReturnType<typeof openMemoryDb>): unknown {
  return db.prepare('SELECT COUNT(*) AS n FROM settings').get();
}

describe('createSettingsService', () => {
  it('returns DEFAULT_SETTINGS on an empty database', () => {
    const { service } = setup();
    expect(service.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns a fresh object on every get', () => {
    const { service } = setup();
    const first = service.get();
    first.quiet_hours.start = '23:00';
    expect(service.get().quiet_hours.start).toBe('00:00');
    expect(DEFAULT_SETTINGS.quiet_hours.start).toBe('00:00');
  });

  it('merges a patch, persists it and emits settings.updated', () => {
    const { db, bus, events, service } = setup();
    const next = service.update({ away: true, escalate_after_min: 5 });
    expect(next).toEqual({ ...DEFAULT_SETTINGS, away: true, escalate_after_min: 5 });
    expect(events).toEqual([next]);
    expect(createSettingsService({ db, bus }).get()).toEqual(next);
    expect(db.prepare('SELECT value_json FROM settings WHERE key = ?').get('escalate_after_min')).toEqual({ value_json: '5' });
  });

  it('replaces quiet_hours as a whole object', () => {
    const { service } = setup();
    const quiet = { start: '22:30', end: '07:00', tz: 'Etc/GMT-4' as const };
    expect(service.update({ quiet_hours: quiet }).quiet_hours).toEqual(quiet);
    expect(service.get().quiet_hours).toEqual(quiet);
  });

  it.for([
    { name: 'an out-of-range number', patch: { escalate_after_min: 0 } },
    { name: 'an unknown key', patch: { bogus: 1 } },
    { name: 'a partial quiet_hours', patch: { quiet_hours: { start: '22:00' } } },
    { name: 'an unknown owner time zone', patch: { owner_tz: 'Mars/Olympus' } },
    { name: 'an invalid HH:MM', patch: { digest_time: '25:00' } },
  ])('rejects $name without persisting or emitting', ({ patch }) => {
    const { db, events, service } = setup();
    expect(() => service.update(patch as unknown as SettingsPatch)).toThrow(ValidationError);
    expect(rowCount(db)).toEqual({ n: 0 });
    expect(events).toEqual([]);
  });

  it('ignores corrupt and unknown stored rows', () => {
    const { db, service } = setup();
    const insert = db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)');
    insert.run('escalate_after_min', '"abc"');
    insert.run('away', '{not json');
    insert.run('legacy_key', '1');
    insert.run('night_calls', 'true');
    expect(service.get()).toEqual({ ...DEFAULT_SETTINGS, night_calls: true });
  });

  it('does not mutate the patch', () => {
    const { service } = setup();
    const patch = Object.freeze({ night_calls: true });
    expect(() => service.update(patch)).not.toThrow();
    expect(patch).toEqual({ night_calls: true });
  });
});
