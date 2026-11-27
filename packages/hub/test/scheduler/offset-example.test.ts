import { afterEach, describe, expect, it } from 'vitest';
import { setOwnerZone } from '@luady/shared';
import { firstRunAt } from '../../src/scheduler/service.js';

afterEach(() => {
  setOwnerZone('Etc/GMT-4');
});

describe('the schedule refusal names the owner offset of the day it shows, across DST', () => {
  it('in Etc/GMT-4, America/New_York and Australia/Sydney', () => {
    const now = new Date('2026-11-21T08:00:00.000Z');
    expect(() => firstRunAt('soon', now)).toThrow('(2026-11-22T09:00:00+04:00)');
    setOwnerZone('America/New_York');
    expect(() => firstRunAt('soon', now)).toThrow('(2026-11-22T09:00:00-05:00)');
    setOwnerZone('Australia/Sydney');
    expect(() => firstRunAt('soon', now)).toThrow('(2026-11-22T09:00:00+11:00)');
  });
});
