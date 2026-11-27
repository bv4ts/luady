import { useEffect, useRef, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import { Icon } from '../../../ui/Icon.js';
import { useViewport } from '../model/useViewport.js';
import { panelMode } from './insets.js';
import './panels.css';

/** Presses, wheel and touches on the panel end here: nothing behind it (the map) may react to them. */
const keepInside = (event: SyntheticEvent) => event.stopPropagation();

/**
 * The frame of every panel: a 360 px dock on the right of a wide screen, a bottom sheet on a phone.
 * Focus moves in when it opens (and when its content changes), and back to where it was when it closes.
 */
export function PanelFrame({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const { width } = useViewport();
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    ref.current?.focus();
  }, [label]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <section ref={ref} className={`agency-panel agency-panel--${panelMode(width)}`} role="dialog" aria-modal="false"
      aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}
      onPointerDown={keepInside} onPointerUp={keepInside} onWheel={keepInside} onContextMenu={keepInside}
      onTouchStart={keepInside} onTouchEnd={keepInside}>
      <button type="button" className="agency-panel__close" aria-label="Close panel" onClick={onClose}><Icon name="x" /></button>
      {children}
    </section>
  );
}
