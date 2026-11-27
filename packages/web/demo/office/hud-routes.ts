import { mergeWebPrefs, type RecapDTO, type UpdateWebPrefsBody, type WebPrefsDTO, type WsServerMessage } from '@luady/shared';
import { MINUTE, iso } from './data.js';

/**
 * HUD demo routes: the welcome-back recap, the website preferences, and enough schedules and links for the map's
 * badges. The pop-ups' own demo data is in the drawers demo.
 */
const RECAP: RecapDTO = {
  since: iso(-95 * MINUTE),
  until: iso(0),
  waiting: [
    { at: iso(-6 * MINUTE), text: 'jira-1105 asks which refund rule to use for partial orders', ref: { kind: 'question', id: 'QASKAAAA' }, server: 'birch' },
    { at: iso(-4 * MINUTE), text: 'meadow-api wants to run the migration on staging', ref: { kind: 'question', id: 'QPERMAAA' }, server: 'cedar' },
  ],
  failed: [
    { at: iso(-40 * MINUTE), text: 'Disk on ash is below 10 GB', ref: null, server: 'ash' },
  ],
  finished: [
    { at: iso(-12 * MINUTE), text: 'Payroll export uses ISO dates: 41 tests pass', ref: { kind: 'todo', id: '21' }, server: 'birch' },
    { at: iso(-30 * MINUTE), text: 'meadow-vat quarterly return PDF is ready', ref: { kind: 'session', id: 'cedar:meadow-vat:0.0' }, server: 'cedar' },
    { at: iso(-52 * MINUTE), text: 'Harbor sitemap submitted for the new pages', ref: null, server: 'ash' },
    { at: iso(-70 * MINUTE), text: 'client-sandbox README rewritten', ref: null, server: 'local' },
    { at: iso(-80 * MINUTE), text: 'store-desk printer queue unblocked', ref: null, server: 'birch' },
  ],
  meetings: [
    { at: iso(-60 * MINUTE), text: 'Weekly sync with the Orchard team', ref: { kind: 'note', id: 'm:weekly' }, server: null },
  ],
  cards: { added: 3, done: 5 },
  sessions: { started: 2, ended: 1 },
};

export function createHudRoutes(push: (message: WsServerMessage) => void) {
  let prefs: WebPrefsDTO = { sound: { muted: false, volume: 0.6 }, dayNight: true };
  return (method: string, path: string, body: Record<string, unknown>): unknown | undefined => {
    if (method === 'GET' && path === '/api/recap') return RECAP;
    if (method === 'GET' && path === '/api/prefs') return prefs;
    if (method === 'PUT' && path === '/api/prefs') {
      prefs = mergeWebPrefs(prefs, body as UpdateWebPrefsBody);
      setTimeout(() => push({ type: 'prefs.changed', at: iso(0) }), 50);
      return prefs;
    }
    if (method === 'GET' && path === '/api/schedules') {
      return { items: [{ id: 's1', when: 'every weekday at 9:00', task: 'Morning brief', nextRunAt: iso(9 * 60 * MINUTE) }, { id: 's2', when: 'tomorrow 3 PM', task: 'Remind me to call the bank', nextRunAt: iso(17 * 60 * MINUTE) }] };
    }
    if (method === 'GET' && path === '/api/links') {
      return { items: [
        { id: 1, server: 'birch', label: 'Jira', url: 'https://orchard-demo.atlassian.net', position: 0 },
        { id: 2, server: 'birch', label: 'Staging', url: 'https://staging.orchard.example', position: 1 },
        { id: 3, server: 'birch', label: 'GitHub', url: 'https://git.example/orchard', position: 2 },
        { id: 4, server: 'cedar', label: 'Admin', url: 'https://admin.meadow.example', position: 0 },
      ] };
    }
    return undefined;
  };
}
