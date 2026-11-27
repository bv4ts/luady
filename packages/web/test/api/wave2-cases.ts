import type { StepCRouteCase } from './step-c-cases.js';

/** Route cases for the recap, fleet, wins, timeline, schedules, links and prefs API modules, shared with client.test.ts. */
const AT = '2026-11-15T09:00:00.000Z';
const LINK = { id: 1, server: 'birch', label: 'Staging', url: 'https://staging.orchard.example', position: 0 };
const SCHEDULE = { id: 'S1', when: '0 9 * * 1-5', task: 'Morning check', nextRunAt: AT };
const PREFS = { sound: { muted: false, volume: 0.6 }, dayNight: true };
const RECAP = {
  since: AT, until: AT, finished: [], failed: [], waiting: [], meetings: [], cards: { added: 0, done: 0 }, sessions: { started: 0, ended: 0 },
};

export const WAVE2_CASES: StepCRouteCase[] = [
  { name: 'recap', call: (a) => a.recap('2026-11-15T08:00:00+04:00'), method: 'GET', url: '/api/recap?since=2026-11-15T08%3A00%3A00%2B04%3A00', response: RECAP },
  { name: 'fleetHistory', call: (a) => a.fleetHistory(), method: 'GET', url: '/api/fleet/history', response: { servers: [], accounts: [] } },
  { name: 'wins', call: (a) => a.wins(14), method: 'GET', url: '/api/wins?days=14', response: { items: [], byServer: {} } },
  { name: 'wins (default days)', call: (a) => a.wins(), method: 'GET', url: '/api/wins', response: { items: [], byServer: {} } },
  { name: 'timeline', call: (a) => a.timeline('2026-11-14'), method: 'GET', url: '/api/timeline?day=2026-11-14', response: { day: '2026-11-14', items: [] } },
  { name: 'schedules', call: (a) => a.schedules(), method: 'GET', url: '/api/schedules', response: { items: [SCHEDULE] } },
  {
    name: 'addSchedule', call: (a) => a.addSchedule({ when: '0 9 * * 1-5', task: 'Morning check' }), method: 'POST', url: '/api/schedules',
    body: { when: '0 9 * * 1-5', task: 'Morning check' }, response: SCHEDULE,
  },
  { name: 'cancelSchedule', call: (a) => a.cancelSchedule('S1'), method: 'POST', url: '/api/schedules/S1/cancel', body: {}, response: { ok: true } },
  { name: 'links', call: (a) => a.links(), method: 'GET', url: '/api/links', response: { items: [LINK] } },
  {
    name: 'createLink', call: (a) => a.createLink({ server: 'birch', label: 'Staging', url: 'https://staging.orchard.example' }), method: 'POST',
    url: '/api/links', body: { server: 'birch', label: 'Staging', url: 'https://staging.orchard.example' }, response: LINK,
  },
  { name: 'updateLink', call: (a) => a.updateLink(1, { position: 2 }), method: 'PUT', url: '/api/links/1', body: { position: 2 }, response: LINK },
  { name: 'deleteLink', call: (a) => a.deleteLink(1), method: 'POST', url: '/api/links/1/delete', body: {}, response: { ok: true } },
  { name: 'prefs', call: (a) => a.prefs(), method: 'GET', url: '/api/prefs', response: PREFS },
  { name: 'updatePrefs', call: (a) => a.updatePrefs({ dayNight: false }), method: 'PUT', url: '/api/prefs', body: { dayNight: false }, response: PREFS },
];
