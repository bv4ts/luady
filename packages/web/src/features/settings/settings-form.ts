import { SettingsSchema, type Settings, type SettingsPatch } from '@luady/shared';

export type SettingsErrors = Readonly<Record<string, string>>;

const RULES: Readonly<Record<string, string>> = {
  escalate_after_min: 'Use a whole number from 1 to 240.',
  hook_wait_seconds: 'Use a whole number from 60 to 86400.',
  finished_min_seconds: 'Use a whole number from 0 to 86400.',
  call_rate_per_hour: 'Use a whole number from 0 to 10.',
  'quiet_hours.start': 'Use a 24-hour time like 23:00.',
  'quiet_hours.end': 'Use a 24-hour time like 07:00.',
  graphify_time: 'Use a 24-hour time like 02:00.',
  digest_time: 'Use a 24-hour time like 03:30.',
  rotate_time: 'Use a 24-hour time like 04:00.',
  manager_model: 'Enter a model name (1 to 64 characters).',
  manager_effort: 'Pick low, medium, high, xhigh or max.',
  voice_model: 'Enter a model name (1 to 64 characters).',
};

export function validateSettings(next: Settings): SettingsErrors {
  const result = SettingsSchema.safeParse(next);
  if (result.success) return {};
  const entries = result.error.issues.map((issue) => {
    const key = issue.path.map(String).join('.');
    return [key, RULES[key] ?? issue.message] as const;
  });
  // Object.fromEntries keeps the last duplicate; reverse so the first issue per field wins.
  return Object.fromEntries(entries.reverse());
}

export function diffSettings(base: Settings, next: Settings): SettingsPatch {
  const keys = Object.keys(base) as Array<keyof Settings>;
  const changed = keys.filter((key) => JSON.stringify(base[key]) !== JSON.stringify(next[key]));
  return Object.fromEntries(changed.map((key) => [key, next[key]])) as SettingsPatch;
}

export function readNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

export function withValue<K extends keyof Settings>(form: Settings, key: K, value: Settings[K]): Settings {
  return { ...form, [key]: value };
}
