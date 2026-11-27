import type { TranscriptItemDTO } from '@luady/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, type UIEvent } from 'react';
import { ownerTime, truncate } from '../../lib/format.js';
import { Markdown } from '../../markdown/Markdown.js';
import { Button } from '../../ui/Button.js';
import { Icon } from '../../ui/Icon.js';

function firstLine(text: string): string {
  return truncate(text.split('\n', 1)[0] ?? '', 120);
}

function Time({ ts }: { ts: string | null }) {
  const label = ownerTime(ts);
  return label && ts ? <time className="msg__time" dateTime={ts}>{label}</time> : null;
}

function Entry({ item }: { item: TranscriptItemDTO }) {
  switch (item.role) {
    case 'user':
      return <div className="msg msg--user"><p className="msg__text" dir="auto">{item.text}</p><Time ts={item.ts} /></div>;
    case 'assistant':
      return <div className="msg msg--assistant"><Markdown source={item.text} /><Time ts={item.ts} /></div>;
    case 'tool':
      return (
        <details className="msg msg--tool">
          <summary>
            <Icon name="terminal" />
            <span className="msg__tool-name">{item.toolName ?? 'tool'}</span>
            <span className="msg__tool-preview">{firstLine(item.text)}</span>
          </summary>
          <pre className="msg__tool-body">{item.text}</pre>
        </details>
      );
    case 'system':
      return <p className="msg msg--system" dir="auto">{item.text}</p>;
  }
}

/** Stays pinned to the newest item, holds the position when older pages load, and loads older pages near the top. */
function useTranscriptScroll(items: readonly TranscriptItemDTO[], hasOlder: boolean, onLoadOlder: () => void) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const firstId = useRef<string | null>(null);
  const lastHeight = useRef(0);
  const pinnedToBottom = useRef(true);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = items[0]?.uuid ?? null;
    if (firstId.current !== null && first !== firstId.current && lastHeight.current > 0) {
      el.scrollTop += el.scrollHeight - lastHeight.current;
    } else if (pinnedToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    firstId.current = first;
    lastHeight.current = el.scrollHeight;
  }, [items]);

  useEffect(() => {
    const target = sentinelRef.current;
    const root = scrollRef.current;
    if (!target || !root || !hasOlder || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadOlder();
    }, { root, rootMargin: '240px 0px 0px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasOlder, onLoadOlder]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  return { scrollRef, sentinelRef, onScroll };
}

export function Transcript({ items, hasOlder, loadingOlder, onLoadOlder }: {
  items: readonly TranscriptItemDTO[]; hasOlder: boolean; loadingOlder: boolean; onLoadOlder: () => void;
}) {
  const { scrollRef, sentinelRef, onScroll } = useTranscriptScroll(items, hasOlder, onLoadOlder);
  return (
    <div className="transcript" ref={scrollRef} role="log" aria-label="Transcript" tabIndex={0} onScroll={onScroll}>
      <div ref={sentinelRef} aria-hidden="true" />
      {hasOlder ? (
        <div className="transcript__older">
          <Button variant="ghost" size="sm" busy={loadingOlder} onClick={onLoadOlder}>Load earlier messages</Button>
        </div>
      ) : items.length > 0 ? <p className="transcript__start">Start of the transcript</p> : null}
      {items.length === 0 ? <p className="transcript__empty">No messages yet.</p> : null}
      {items.map((item) => <Entry key={item.uuid} item={item} />)}
    </div>
  );
}
