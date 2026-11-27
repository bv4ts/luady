import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** The class of the element office pop-ups are portalled into: agency.css defines the office tokens on it as on `.agency`. */
export const OFFICE_TOKENS_CLASS = 'agency-tokens';

/**
 * Renders an office pop-up at the end of <body>, outside `.agency` (so nothing on the page clips it or stacks over it),
 * inside an element that carries the office tokens: the --agency-* custom properties are defined there too, so the
 * pop-up keeps its background, colours and sizes. Every office pop-up that leaves `.agency` goes through here; the
 * element draws no box of its own (`display: contents`).
 */
export function OfficePortal({ children }: { children: ReactNode }) {
  return createPortal(<div className={OFFICE_TOKENS_CLASS}>{children}</div>, document.body);
}
