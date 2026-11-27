import type { AgencySnapshot } from '@luady/office';
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../../../api/context.js';
import { isApiError } from '../../../api/errors.js';
import { reportError } from '../../../lib/report.js';
import { cardList } from '../../../state/board.js';
import { useStore } from '../../../state/store.js';
import { pickEnergy } from './energy.js';
import { boardBadge, boardCounts, dueWithinDay, fleetAlert, winsThisWeek, type Badge } from './hud-badges.js';
import { fixtureBadges, type MapBadge } from './map-labels.js';
import { useNewNotes } from './useNewNotes.js';

const NO_JIRA: Readonly<Record<string, number | null>> = Object.freeze({});
const NO_LINKS: Readonly<Record<string, number>> = Object.freeze({});
/** The schedule board's count is recounted this often (runs come due without any message). */
const SCHEDULE_RECOUNT_MS = 5 * 60_000;

/** An older hub (404) or a stub (501): no badge, no noise. */
const quiet = (what: string) => (err: unknown): void => {
  if (!(isApiError(err) && (err.status === 404 || err.status === 501))) reportError(what, err);
};

/** How many schedules run in the next 24 hours; refetched on `schedules.changed` and every few minutes. */
function useScheduleSoon(): number | undefined {
  const api = useApi();
  const version = useStore().state.schedulesVersion;
  const [items, setItems] = useState<readonly { nextRunAt: string | null }[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), SCHEDULE_RECOUNT_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let alive = true;
    api.schedules().then((list) => {
      if (alive) setItems(list.items);
    }, quiet('schedules count'));
    return () => {
      alive = false;
    };
  }, [api, version]);
  return items === null ? undefined : dueWithinDay(items, now);
}

/** Each office's links, by server; refetched on `links.changed`. */
function useLinkCounts(): Readonly<Record<string, number>> {
  const api = useApi();
  const version = useStore().state.linksVersion;
  const [counts, setCounts] = useState(NO_LINKS);
  useEffect(() => {
    let alive = true;
    api.links().then((list) => {
      if (!alive) return;
      const next: Record<string, number> = {};
      list.items.forEach((link) => {
        next[link.server] = (next[link.server] ?? 0) + 1;
      });
      setCounts(Object.freeze(next));
    }, quiet('links count'));
    return () => {
      alive = false;
    };
  }, [api, version]);
  return counts;
}

/** Each connected office's tickets that need attention, by server; refetched on every `jira.changed`. */
function useJiraAttention(): Readonly<Record<string, number | null>> {
  const api = useApi();
  const version = useStore().state.jiraVersion;
  const [attention, setAttention] = useState(NO_JIRA);
  useEffect(() => {
    let alive = true;
    api.jiraSites().then(
      (list) => {
        if (alive) setAttention(Object.freeze(Object.fromEntries(list.sites.map((site) => [site.server, site.attention]))));
      },
      (err: unknown) => {
        if (!(isApiError(err) && (err.status === 404 || err.status === 501))) reportError('jira attention', err);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, version]);
  return attention;
}

export interface HudBadges {
  /** The Board button and the cork board: to do + needs you. */
  readonly board: Badge | null;
  /** Meeting notes since Notes was last opened. */
  readonly newNotes: number;
  /** Badges on the map's fixtures, by fixture id. */
  readonly fixtures: Readonly<Record<string, MapBadge>>;
}

/** Everything the top bar's buttons and the map's fixtures count, from one place. `notesOpen`: Notes is showing. */
export function useHudBadges(snapshot: AgencySnapshot, notesOpen: boolean): HudBadges {
  const { board: slice, sessions, accounts, servers } = useStore().state;
  const newNotes = useNewNotes(notesOpen);
  const jira = useJiraAttention();
  const scheduleSoon = useScheduleSoon();
  const links = useLinkCounts();
  const board = useMemo(() => boardBadge(boardCounts(cardList(slice), sessions, Date.now())), [slice, sessions]);
  const energy = useMemo(() => pickEnergy(accounts?.accounts ?? [], null), [accounts]);
  const wave2 = useMemo(() => {
    const now = Date.now();
    return {
      fleetAlert: fleetAlert(servers, accounts?.accounts ?? [], now),
      winsWeek: winsThisWeek(cardList(slice), now),
      links,
      ...(scheduleSoon === undefined ? {} : { scheduleSoon }),
    };
  }, [servers, accounts, slice, links, scheduleSoon]);
  const fixtures = useMemo(() => fixtureBadges(snapshot, { board, newNotes, energy, jira, ...wave2 }), [snapshot, board, newNotes, energy, jira, wave2]);
  return { board, newNotes, fixtures };
}
