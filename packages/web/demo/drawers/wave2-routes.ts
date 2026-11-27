import type { BoardItemDTO, LinkDTO, ScheduleItemDTO } from '@luady/shared';
import { LINKS, fleetHistory, remindCards, schedules, timeline, wins } from './wave2-data.js';

/** The pop-up routes of the demo's pretend hub, with the little state they change. Null = not one of these. */
export interface Wave2Routes {
  handle(method: string, path: string, query: URLSearchParams, body: Record<string, unknown>): Response | null;
  /** Adds the reminder cards to the office demo's board list. */
  withCards(response: Response): Promise<Response>;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function createWave2Routes(): Wave2Routes {
  const started = Date.now();
  let plan: readonly ScheduleItemDTO[] = schedules(started);
  let links: readonly LinkDTO[] = LINKS;
  let cards: readonly BoardItemDTO[] = remindCards(started);
  let nextId = 100;

  return {
    async withCards(response) {
      const list = (await response.json()) as { items: BoardItemDTO[] };
      return json({ items: [...list.items.filter((c) => !cards.some((mine) => mine.id === c.id)), ...cards] });
    },
    handle(method, path, query, body) {
      const now = Date.now();
      if (method === 'GET' && path === '/api/fleet/history') return json(fleetHistory(now));
      if (method === 'GET' && path === '/api/wins') return json(wins(now));
      if (method === 'GET' && path === '/api/timeline') return json(timeline(query.get('day'), now));
      if (method === 'GET' && path === '/api/schedules') return json({ items: plan });
      if (method === 'POST' && path === '/api/schedules') {
        nextId += 1;
        const item = { id: `sch_${String(nextId)}`, when: String(body.when), task: String(body.task), nextRunAt: new Date(now + 20 * 3_600_000).toISOString() };
        plan = [...plan, item];
        return json(item);
      }
      const cancel = /^\/api\/schedules\/([^/]+)\/cancel$/.exec(path);
      if (cancel !== null) {
        plan = plan.filter((item) => item.id !== cancel[1]);
        return json({ ok: true });
      }
      if (method === 'GET' && path === '/api/links') return json({ items: links });
      if (method === 'POST' && path === '/api/links') {
        nextId += 1;
        const server = body.server as LinkDTO['server'];
        const link: LinkDTO = { id: nextId, server, label: String(body.label), url: String(body.url), position: links.filter((l) => l.server === server).length };
        links = [...links, link];
        return json(link);
      }
      const one = /^\/api\/links\/(\d+)(\/delete)?$/.exec(path);
      if (one !== null) {
        const id = Number(one[1]);
        if (one[2] !== undefined) {
          links = links.filter((l) => l.id !== id);
          return json({ ok: true });
        }
        const next = { ...(links.find((l) => l.id === id) as LinkDTO), ...(body as Partial<LinkDTO>) };
        links = links.map((l) => (l.id === id ? next : l));
        return json(next);
      }
      const card = /^\/api\/board\/(\d+)$/.exec(path);
      const mine = card === null ? undefined : cards.find((c) => c.id === Number(card[1]));
      if (card !== null && mine !== undefined) {
        if (method === 'PUT') {
          const next = { ...mine, ...(body as Partial<BoardItemDTO>), updatedAt: new Date(now).toISOString() };
          cards = cards.map((c) => (c.id === mine.id ? next : c));
          return json(next);
        }
        return json({ item: mine, events: [], mission: null });
      }
      return null;
    },
  };
}
