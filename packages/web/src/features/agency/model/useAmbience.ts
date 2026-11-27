import { localParts, ownerZone, type Settings } from '@luady/shared';
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../../../api/context.js';
import { isApiError } from '../../../api/errors.js';
import { reportError } from '../../../lib/report.js';
import { useStore } from '../../../state/store.js';
import type { StageAmbience } from '../stage-types.js';

type QuietHours = Pick<Settings['quiet_hours'], 'start' | 'end'>;

const MINUTE_MS = 60_000;
/** How often the quiet-hours check looks at the clock. */
export const AMBIENCE_CLOCK_MS = MINUTE_MS;

const minutesOf = (hhmm: string): number => {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

/** Minutes since midnight on the owner's wall clock, in the owner's zone at that instant (DST-safe). */
function ownerMinuteOfDay(nowMs: number): number {
  const parts = localParts(ownerZone(), nowMs);
  return parts.hour * 60 + parts.minute;
}

/**
 * True inside the owner's quiet hours in owner time. Same rule as the hub (core/time.ts inQuietHours): start
 * inclusive, end exclusive, a window may cross midnight, start equal to end means never quiet.
 */
export function isQuietAt(nowMs: number, quiet: QuietHours): boolean {
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return false;
  const now = ownerMinuteOfDay(nowMs);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

function useNowMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), AMBIENCE_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The quiet hours are read again this often while the office is open (a change on another device shows up). */
export const QUIET_HOURS_REFRESH_MS = 10 * MINUTE_MS;

const sameHours = (a: QuietHours | null, b: QuietHours): boolean => a !== null && a.start === b.start && a.end === b.end;

/**
 * The hub's quiet hours (GET /api/settings); null until they arrive or when they cannot be read. Read when the office
 * opens (so a change saved on the settings page applies on the way back), when the tab is shown again, after a
 * reconnect, and every 10 minutes; the same object while they do not change.
 */
function useQuietHours(): QuietHours | null {
  const api = useApi();
  const { epoch } = useStore().state.connection;
  const [quiet, setQuiet] = useState<QuietHours | null>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    const again = () => setAsked((n) => n + 1);
    const onVisible = () => {
      if (document.visibilityState === 'visible') again();
    };
    const timer = setInterval(again, QUIET_HOURS_REFRESH_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    api.settings().then(
      (settings) => {
        if (!alive) return;
        const next = { start: settings.quiet_hours.start, end: settings.quiet_hours.end };
        setQuiet((prev) => (sameHours(prev, next) ? prev : next));
      },
      (err: unknown) => {
        if (!(isApiError(err) && (err.status === 401 || err.status === 404))) reportError('quiet hours', err);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, epoch, asked]);
  return quiet;
}

/**
 * What the stage's day and night needs: `enabled` from the website preferences (`dayNight`),
 * `quiet` = now inside the hub's quiet hours. The same object while neither changes.
 */
export function useAmbience(): StageAmbience {
  const enabled = useStore().state.prefs.value.dayNight;
  const hours = useQuietHours();
  const now = useNowMinute();
  const quiet = hours !== null && isQuietAt(now, hours);
  return useMemo(() => Object.freeze({ enabled, quiet }), [enabled, quiet]);
}
