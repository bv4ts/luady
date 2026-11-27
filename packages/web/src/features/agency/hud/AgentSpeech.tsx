import { MUTE_PALETTE, type AgencySnapshot } from '@luady/office';
import { isHostId, isSelfHost, type SaidDTO, type SessionDTO } from '@luady/shared';
import { memo, useCallback, useEffect, useMemo, useState, type SyntheticEvent } from 'react';
import { useApi } from '../../../api/context.js';
import { userMessage } from '../../../api/errors.js';
import { Markdown } from '../../../markdown/Markdown.js';
import type { SaidEntry } from '../../../state/said.js';
import { useStore } from '../../../state/store.js';
import { Icon } from '../../../ui/Icon.js';
import {
  EMPTY_BUBBLES, arrive, bubbleMs, fold, hold, keepOnly, nextFold, reopen, tick, type BubbleQueue, type SaidArrival,
} from '../model/bubble-queue.js';
import { teamStyle } from '../model/team-style.js';
import { plainLine } from '../model/words.js';
import { PixelIcon } from './PixelIcon.js';
import type { SpeechRegister } from './useSpeechPlacer.js';

/** A bubble opened to be read in full stays at least this long. */
const READING_MS = 60_000;
const CARD_TITLE_MAX = 300;

/** Presses on a bubble end here: the map behind it must not take them as a tap on the floor. */
const keepInside = (event: SyntheticEvent) => event.stopPropagation();

/**
 * How long the words are for the two bubble sizes ('office': two lines at 180 px, 'room': six at 260 px), so "More"
 * shows only when something is cut. The hub's own cut (`truncated`) always counts.
 */
export function lengthClass(said: SaidDTO): 'short' | 'office' | 'both' {
  const lines = said.text.split('\n').filter((line) => line.trim() !== '').length;
  if (said.truncated || said.text.length > 230 || lines > 6) return 'both';
  if (said.text.length > 70 || lines > 2) return 'office';
  return 'short';
}

/** A new card from what an agent said: its first line as the title, all of it as the details, its office and project. */
export function cardFromSaid(said: SaidDTO, session: SessionDTO | undefined) {
  const title = plainLine(said.text, CARD_TITLE_MAX) || 'From an agent';
  // The card is for the session's host; the manager's own sessions name none.
  const server = session !== undefined && isHostId(session.host) && !isSelfHost(session.host) ? session.host : undefined;
  return {
    title, details: said.text, source: 'session' as const, sourceRef: said.sessionId,
    ...(server === undefined ? {} : { server }), ...(session?.project ? { project: session.project } : {}),
  };
}

function useAddToBoard() {
  const api = useApi();
  const { state, toast } = useStore();
  const sessions = state.sessions;
  return useCallback(async (said: SaidDTO) => {
    try {
      const card = await api.createCard(cardFromSaid(said, sessions.find((session) => session.id === said.sessionId)));
      toast('success', `Added to the board as #${card.id}.`);
    } catch (err) {
      toast('error', userMessage(err));
    }
  }, [api, sessions, toast]);
}

interface BubbleProps {
  readonly said: SaidDTO;
  readonly name: string;
  readonly snapshot: AgencySnapshot;
  readonly expanded: boolean;
  readonly register: SpeechRegister;
  readonly onExpand: (id: string) => void;
  readonly onClose: (id: string) => void;
  readonly onHover: (id: string) => void;
  readonly onOpenAgent: (id: string) => void;
  readonly onAdd: (said: SaidDTO) => Promise<void>;
}

const AgentBubble = memo(function AgentBubble({ said, name, snapshot, expanded, register, onExpand, onClose, onHover, onOpenAgent, onAdd }: BubbleProps) {
  const id = said.sessionId;
  const ref = useMemo(() => register(id), [register, id]);
  const [adding, setAdding] = useState(false);
  const palette = snapshot.actors[id]?.look.palette ?? MUTE_PALETTE;
  const add = () => {
    setAdding(true);
    void onAdd(said).finally(() => setAdding(false));
  };
  return (
    <div ref={ref} className="speech speech--agent" style={teamStyle(palette)} data-long={lengthClass(said)} data-expanded={expanded}
      data-testid="agent-speech" data-session={id} role="group" aria-label={`${name} said`}
      onPointerEnter={() => onHover(id)} onPointerDown={keepInside} onPointerUp={keepInside} onWheel={keepInside}
      onContextMenu={keepInside} onTouchStart={keepInside} onTouchEnd={keepInside}>
      <div className="speech__box">
        <p className="speech__head">
          <span className="speech__name" dir="auto">{name}</span>
          {said.kind === 'report' ? <span className="speech__kind">Report</span> : null}
          <button type="button" className="speech__close" aria-label={`Close what ${name} said`} onClick={() => onClose(id)}><Icon name="x" /></button>
        </p>
        <Markdown source={said.text} className="speech__text" />
        <p className="speech__actions">
          {expanded ? null : <button type="button" className="speech__btn speech__more" onClick={() => onExpand(id)}>More</button>}
          {expanded && said.truncated ? (
            <button type="button" className="speech__btn" onClick={() => onOpenAgent(id)}>Open {name} for the rest</button>
          ) : null}
          <button type="button" className="speech__btn" disabled={adding} onClick={add}>
            <PixelIcon name="plus" size={10} />Add to board
          </button>
        </p>
      </div>
      <span className="speech__tail" aria-hidden="true" />
    </div>
  );
});

function SpeechMark({ id, name, register, onOpen }: { id: string; name: string; register: SpeechRegister; onOpen: (id: string) => void }) {
  const ref = useMemo(() => register(id), [register, id]);
  return (
    <button ref={ref} type="button" className="speech-mark" data-testid="speech-mark" data-session={id}
      aria-label={`Show what ${name} said`} title={`What ${name} said`}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') onOpen(id); }}
      onClick={() => onOpen(id)} onPointerDown={keepInside} onPointerUp={keepInside} onTouchStart={keepInside} onTouchEnd={keepInside}>
      <PixelIcon name="quote" size={14} />
    </button>
  );
}

const arrivalOf = (entry: SaidEntry): SaidArrival => ({ sessionId: entry.said.sessionId, seq: entry.seq, text: entry.said.text });

/** The queue fed by the store's `said` slice (only characters on the map), with its fold timer. */
function useBubbleQueue(snapshot: AgencySnapshot) {
  const { said } = useStore().state;
  const [queue, setQueue] = useState<BubbleQueue>(EMPTY_BUBBLES);
  const entries = useMemo(
    () => Object.values(said.bySession).filter((entry) => Object.hasOwn(snapshot.actors, entry.said.sessionId)),
    [said, snapshot.actors],
  );

  useEffect(() => {
    const live = new Set(entries.map((entry) => entry.said.sessionId));
    setQueue((prev) => keepOnly(arrive(prev, entries.map(arrivalOf), Date.now()), live));
  }, [entries]);

  const due = nextFold(queue);
  useEffect(() => {
    if (due === null) return undefined;
    const timer = setTimeout(() => setQueue((prev) => tick(prev, Date.now())), Math.max(0, due - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [due]);

  return { queue, setQueue, entries };
}

/**
 * What the agents said: a paper bubble above the character when a turn ends or it reports, for 6 to 20
 * seconds by length, at most four at once; then a small speech mark that shows the words again on hover or tap.
 */
export function AgentSpeech({ snapshot, register, onOpenAgent }: {
  snapshot: AgencySnapshot; register: SpeechRegister; onOpenAgent: (id: string) => void;
}) {
  const { queue, setQueue, entries } = useBubbleQueue(snapshot);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const onAdd = useAddToBoard();
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.said.sessionId, entry])), [entries]);

  const openIds = queue.open.map((bubble) => bubble.sessionId).join(' ');
  useEffect(() => {
    // A bubble that folded is no longer opened up for reading.
    setExpanded((prev) => {
      const still = new Set([...prev].filter((id) => openIds.split(' ').includes(id)));
      return still.size === prev.size ? prev : still;
    });
  }, [openIds]);

  const onOpen = useCallback((id: string) => {
    const entry = byId.get(id);
    if (entry !== undefined) setQueue((prev) => reopen(prev, arrivalOf(entry), Date.now()));
  }, [byId, setQueue]);
  const onClose = useCallback((id: string) => setQueue((prev) => fold(prev, id)), [setQueue]);
  const onHover = useCallback((id: string) => {
    const entry = byId.get(id);
    if (entry !== undefined) setQueue((prev) => hold(prev, id, Date.now() + bubbleMs(entry.said.text)));
  }, [byId, setQueue]);
  const onExpand = useCallback((id: string) => {
    setExpanded((prev) => new Set([...prev, id]));
    setQueue((prev) => hold(prev, id, Date.now() + READING_MS));
  }, [setQueue]);

  const nameOf = (id: string): string => snapshot.actors[id]?.name ?? 'An agent';
  return (
    <>
      {queue.folded.map((id) => <SpeechMark key={`mark-${id}`} id={id} name={nameOf(id)} register={register} onOpen={onOpen} />)}
      {queue.open.flatMap((bubble) => {
        const entry = byId.get(bubble.sessionId);
        return entry === undefined ? [] : [
          <AgentBubble key={`bubble-${bubble.sessionId}`} said={entry.said} name={nameOf(bubble.sessionId)} snapshot={snapshot}
            expanded={expanded.has(bubble.sessionId)} register={register} onExpand={onExpand} onClose={onClose} onHover={onHover}
            onOpenAgent={onOpenAgent} onAdd={onAdd} />,
        ];
      })}
    </>
  );
}
