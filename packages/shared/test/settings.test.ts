import { describe, expect, it } from 'vitest';
import { CALL_LANGUAGES, DEFAULT_SETTINGS, SettingsPatchSchema, SettingsSchema } from '../src/settings.js';

describe('DEFAULT_SETTINGS', () => {
  it('holds exactly the default value of every setting', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      escalate_after_min: 10,
      hook_wait_seconds: 14400,
      finished_min_seconds: 120,
      quiet_hours: { start: '00:00', end: '08:00' },
      night_calls: false,
      away: false,
      phone_enabled: false,
      call_rate_per_hour: 3,
      call_languages: ['en'],
      manager_model: 'opus',
      manager_effort: 'high',
      voice_model: 'sonnet',
      graphify_time: '02:00',
      digest_time: '03:30',
      rotate_time: '04:00',
      require_pin: true,
      mute_until: null,
      owner_tz: null,
      manager_enabled: false,
      manager_name: 'Luady',
      digest_enabled: false,
      brief_enabled: false,
      claude_update_enabled: false,
      tools_update_enabled: false,
      graphify_enabled: false,
    });
  });

  it('validates against SettingsSchema and parses into a new object', () => {
    const parsed = SettingsSchema.parse(DEFAULT_SETTINGS);
    expect(parsed).toEqual(DEFAULT_SETTINGS);
    expect(parsed).not.toBe(DEFAULT_SETTINGS);
  });
});

describe('SettingsSchema', () => {
  it.each([
    ['an unknown key', { ...DEFAULT_SETTINGS, theme: 'dark' }],
    ['an unknown owner time zone', { ...DEFAULT_SETTINGS, owner_tz: 'Mars/Olympus' }],
    ['24:00', { ...DEFAULT_SETTINGS, digest_time: '24:00' }],
    ['a one-digit hour', { ...DEFAULT_SETTINGS, rotate_time: '4:00' }],
    ['minute 60', { ...DEFAULT_SETTINGS, graphify_time: '02:60' }],
    ['escalation after 0 min', { ...DEFAULT_SETTINGS, escalate_after_min: 0 }],
    ['escalation after 241 min', { ...DEFAULT_SETTINGS, escalate_after_min: 241 }],
    ['a hook wait under a minute', { ...DEFAULT_SETTINGS, hook_wait_seconds: 59 }],
    ['a hook wait over a day', { ...DEFAULT_SETTINGS, hook_wait_seconds: 86401 }],
    ['a call language twice', { ...DEFAULT_SETTINGS, call_languages: ['en', 'en'] }],
    ['no call language', { ...DEFAULT_SETTINGS, call_languages: [] }],
    ['a call language the hub has no voice for', { ...DEFAULT_SETTINGS, call_languages: ['xx'] }],
    ['11 calls per hour', { ...DEFAULT_SETTINGS, call_rate_per_hour: 11 }],
    ['an empty model', { ...DEFAULT_SETTINGS, manager_model: '' }],
    ['an unknown effort', { ...DEFAULT_SETTINGS, manager_effort: 'ultra' }],
    ['an extra quiet_hours key', { ...DEFAULT_SETTINGS, quiet_hours: { ...DEFAULT_SETTINGS.quiet_hours, days: 'all' } }],
  ])('rejects %s', (_label, value) => {
    expect(SettingsSchema.safeParse(value).success).toBe(false);
  });

  it('accepts every call language the hub has a voice for, in any order', () => {
    expect(CALL_LANGUAGES).toEqual(['en', 'ar', 'de', 'fr', 'pt']);
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, call_languages: ['de'] }).success).toBe(true);
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, call_languages: ['pt', 'fr', 'en'] }).success).toBe(true);
  });

  it('accepts a stored legacy quiet_hours zone (ignored) and a real owner zone', () => {
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, quiet_hours: { start: '00:00', end: '08:00', tz: 'Etc/GMT-4' } }).success).toBe(true);
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, owner_tz: 'America/New_York' }).success).toBe(true);
  });

  it('reports unknown keys as unrecognized_keys', () => {
    const result = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, theme: 'dark' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });
});

describe('SettingsPatchSchema', () => {
  it.each([
    [{}],
    [{ away: true }],
    [{ escalate_after_min: 15, night_calls: true }],
    [{ quiet_hours: { start: '23:00', end: '07:00', tz: 'Etc/GMT-4' } }],
  ])('accepts %j', (patch) => {
    expect(SettingsPatchSchema.parse(patch)).toEqual(patch);
  });

  it.each([[{ theme: 'dark' }], [{ away: 'yes' }], [{ quiet_hours: { start: '23:00' } }]])('rejects %j', (patch) => {
    expect(SettingsPatchSchema.safeParse(patch).success).toBe(false);
  });
});
