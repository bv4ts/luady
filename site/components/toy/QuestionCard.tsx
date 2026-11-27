'use client';

import { useEffect, useId, useRef } from 'react';
import { PixelIcon } from '../pixel/PixelIcon';

export interface CardState {
  id: string;
  label: string;
  room: string;
  command: string;
  answered: 'allow' | 'deny' | null;
}

/**
 * A session's question, shaped like the product's permission card: who asks, what it wants to run, and Allow or Deny.
 * Answering stamps the card with a tick (or a cross) and closes it a moment later. Escape closes it unanswered; the
 * session keeps waiting.
 */
export function QuestionCard({ card, onAnswer, onClose }: {
  card: CardState;
  onAnswer: (allow: boolean) => void;
  onClose: (answered: boolean) => void;
}) {
  const title = useId();
  const allowRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // The latest onClose, so the timers below are not restarted each time the page re-renders.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (card.answered === null) allowRef.current?.focus();
    else boxRef.current?.focus();
  }, [card.answered]);

  useEffect(() => {
    if (card.answered === null) return undefined;
    const timer = window.setTimeout(() => closeRef.current(true), 1100);
    return () => window.clearTimeout(timer);
  }, [card.answered]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current(card.answered !== null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [card.answered]);

  return (
    <div className="qcard" role="dialog" aria-labelledby={title} ref={boxRef} tabIndex={-1} data-answered={card.answered ?? undefined}>
      <div className="qcard__head">
        <span className="qcard__badge">Permission</span>
        <span className="qcard__who">{card.label}</span>
        <span className="qcard__room">{card.room}</span>
      </div>
      <p className="qcard__summary" id={title}>Wants to run</p>
      <pre className="qcard__preview"><code>{card.command}</code></pre>
      {card.answered === null ? (
        <div className="qcard__actions">
          <button type="button" className="btn btn--primary btn--small" ref={allowRef} onClick={() => onAnswer(true)}>Allow</button>
          <button type="button" className="btn btn--deny btn--small" onClick={() => onAnswer(false)}>Deny</button>
          <button type="button" className="qcard__later" onClick={() => onClose(false)}>Later</button>
        </div>
      ) : (
        <p className="qcard__stamp" role="status">
          <PixelIcon name={card.answered === 'allow' ? 'bubbles/check' : 'bubbles/cross'} scale={3} className="qcard__stamp-icon" />
          {card.answered === 'allow' ? 'Allowed' : 'Denied'}
        </p>
      )}
    </div>
  );
}
