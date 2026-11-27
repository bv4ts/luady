import { ownerFormat } from '@luady/shared';
import { useEffect, useState } from 'react';

const MINUTE_MS = 60_000;
const CLOCK = ownerFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

/** "3:20 PM" in the owner's time zone (owner time). ICU's narrow no-break space becomes a plain space. */
export function formatClock(ms: number): string {
  return CLOCK.format(ms).replace(/\s/g, ' ');
}

/** The current time, refreshed just after each minute starts. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), MINUTE_MS - (now % MINUTE_MS) + 50);
    return () => clearTimeout(timer);
  }, [now]);
  return now;
}

export function Clock() {
  const now = useMinute();
  return <time className="agency-clock" dateTime={new Date(now).toISOString()} title="Time in owner time">{formatClock(now)}</time>;
}
