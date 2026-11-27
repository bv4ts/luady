import { useEffect, useId, useRef, type KeyboardEvent, type MouseEvent, type ReactNode, type SyntheticEvent } from 'react';
import { Icon } from '../../../ui/Icon.js';
import './ModalFrame.css';

/** Presses, wheel and touches on the pop-up end here: nothing behind it (the map) may react to them. */
const keepInside = (event: SyntheticEvent) => event.stopPropagation();

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => !node.hasAttribute('hidden'));
}

/** Tab and Shift+Tab stay inside the dialog: from the last element back to the first and the other way. */
function trapTab(event: KeyboardEvent<HTMLElement>, root: HTMLElement): void {
  const nodes = focusables(root);
  const first = nodes[0];
  const last = nodes.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    root.focus();
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === root)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * The frame of every large pop-up (Board, Notes, Library, Jira, Activity): a centred dialog over the map, a full
 * screen sheet under 760 px. Focus moves in when it opens and back when it closes; Tab stays inside; Esc and a
 * press outside close it.
 */
export function ModalFrame({ label, badge, onClose, children }: {
  label: string;
  /** A short count after the title ("2 new"), shown as "Notes · 2 new". */
  badge?: string | undefined;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // A part inside that closes (a card sheet, an editor) can leave the focus on the page itself; Esc must still close
  // the top pop-up then, since the page's own shortcuts stand aside while a modal dialog is open.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      const frames = document.querySelectorAll('.modal-frame__dialog');
      if (frames[frames.length - 1] !== ref.current) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Tab' && ref.current !== null) {
      trapTab(event, ref.current);
    }
  };

  const onBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="modal-frame" data-testid="modal-backdrop" onMouseDown={onBackdrop}
      onPointerDown={keepInside} onPointerUp={keepInside} onWheel={keepInside} onContextMenu={keepInside}
      onTouchStart={keepInside} onTouchEnd={keepInside}>
      <div ref={ref} className="modal-frame__dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        onKeyDown={onKeyDown}>
        <header className="modal-frame__head">
          <h2 id={titleId} className="modal-frame__title">
            {label}
            {badge === undefined || badge === '' ? null : <span className="modal-frame__badge"> · {badge}</span>}
          </h2>
          <button type="button" className="modal-frame__close" aria-label={`Close ${label}`} onClick={onClose}><Icon name="x" /></button>
        </header>
        <div className="modal-frame__body">{children}</div>
      </div>
    </div>
  );
}
