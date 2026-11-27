import type { ReactElement } from 'react';

const PATHS = {
  inbox: (<><path d="M4 13.5 6.6 5.8A1.2 1.2 0 0 1 7.7 5h8.6a1.2 1.2 0 0 1 1.1.8l2.6 7.7V18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" /><path d="M4 13.5h4.6l1.4 2.5h4l1.4-2.5H20" /></>),
  sessions: (<><path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z" /><path d="m3.5 12 8.5 4.5 8.5-4.5" /><path d="m3.5 16 8.5 4.5 8.5-4.5" /></>),
  manager: (<path d="M12 3.5c.6 5.6 2.9 7.9 8.5 8.5-5.6.6-7.9 2.9-8.5 8.5-.6-5.6-2.9-7.9-8.5-8.5 5.6-.6 7.9-2.9 8.5-8.5z" />),
  server: (<><rect x="3.5" y="4" width="17" height="7" rx="2" /><rect x="3.5" y="13" width="17" height="7" rx="2" /><path d="M7.5 7.5h.01M7.5 16.5h.01M11 7.5h2M11 16.5h2" /></>),
  settings: (<><path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1" /><circle cx="15" cy="6.5" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="17.5" r="2" /></>),
  terminal: (<><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" /></>),
  send: (<><path d="M20.5 3.5 10 14" /><path d="M20.5 3.5 14 20.5l-4-6.5-6.5-4z" /></>),
  stop: (<rect x="6" y="6" width="12" height="12" rx="2.5" />),
  restart: (<><path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20 4.5V9h-4.5" /></>),
  trash: (<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />),
  pause: (<><circle cx="12" cy="12" r="8.5" /><path d="M10 9v6M14 9v6" /></>),
  /** Pause an agent after its current step (two bars); `pause` above, in a circle, is Interrupt. */
  hold: (<><rect x="6.5" y="5" width="4" height="14" rx="1.2" /><rect x="13.5" y="5" width="4" height="14" rx="1.2" /></>),
  plus: (<path d="M12 5v14M5 12h14" />),
  back: (<path d="m14.5 5.5-6.5 6.5 6.5 6.5" />),
  chevron: (<path d="m9.5 5.5 6.5 6.5-6.5 6.5" />),
  check: (<path d="m5 12.5 4.5 4.5L19 7.5" />),
  x: (<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />),
  alert: (<><path d="M12 4 21 19.5H3z" /><path d="M12 10v4M12 16.8h.01" /></>),
  lock: (<><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>),
  file: (<><path d="M6.5 3.5H14l4 4v13H6.5z" /><path d="M14 3.5v4h4" /></>),
  play: (<path d="M8 5.5v13l10.5-6.5z" />),
  message: (<path d="M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4.5 3.5v-3.5h-1a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" />),
  book: (<><path d="M5.5 4.5h10a3 3 0 0 1 3 3v12h-10a3 3 0 0 1-3-3z" /><path d="M5.5 16.5a3 3 0 0 1 3-3h10" /></>),
  logout: (<><path d="M14.5 4.5h4a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-4" /><path d="m10 8-4 4 4 4M6 12h9.5" /></>),
  key: (<><circle cx="8" cy="15" r="3.5" /><path d="m10.5 12.5 8-8M15.5 7.5l2 2" /></>),
  wifi: (<><path d="M4.5 9.5a11 11 0 0 1 15 0M7.5 12.8a6.5 6.5 0 0 1 9 0" /><path d="M12 16.5h.01" /></>),
  screen: (<><rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5" /><path d="M9 20h6M12 16v4" /></>),
  bell: (<><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>),
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ? `icon ${className}` : 'icon'} viewBox="0 0 24 24" width="20" height="20" fill="none"
      stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
