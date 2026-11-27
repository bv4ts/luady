import type { AgencySnapshot } from '@luady/office';
import type { SessionDTO } from '@luady/shared';
import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { useStore } from '../../../state/store.js';
import type { ActorMenuAt } from '../model/ui-state.js';
import { usePause, type PauseControl } from '../model/usePause.js';
import { LUADY_ACTOR_ID } from '../stage-types.js';
import { useCompact } from './useCompact.js';
import { useSessionCommands } from './useSessionCommands.js';
import { managerName } from '@luady/shared';

interface MenuItem {
  readonly key: string;
  readonly label: string;
  readonly run: () => void;
  readonly testId?: string;
  /** Shown under the label; the item does nothing while it has one. */
  readonly blocked?: string;
}

const EDGE = 8;

function sessionItems(session: SessionDTO, commands: ReturnType<typeof useSessionCommands>): readonly MenuItem[] {
  const stop: MenuItem = { key: 'stop', label: 'Stop now', run: () => void commands.stop(session) };
  const terminal: MenuItem = { key: 'terminal', label: 'Open terminal', run: () => commands.openTerminal(session) };
  const restart: MenuItem = { key: 'restart', label: 'Restart', run: () => void commands.restart(session) };
  return [
    session.state === 'ended' ? null : stop,
    commands.terminalOf(session) === null ? null : terminal,
    session.state === 'error' || session.unexpectedEnd ? restart : null,
  ].filter((item): item is MenuItem => item !== null);
}

/** Pause or Resume (hidden once the server said its kit is too old), then Send a note. */
function liveItems(pause: PauseControl, onNote: () => void): readonly MenuItem[] {
  const toggle: MenuItem = pause.paused
    ? { key: 'resume', label: 'Resume', testId: 'actor-menu-resume', run: () => void pause.toggle() }
    : { key: 'pause', label: 'Pause', testId: 'actor-menu-pause', run: () => void pause.toggle(), ...(pause.reason === null ? {} : { blocked: pause.reason }) };
  const note: MenuItem = { key: 'note', label: 'Send a note', testId: 'actor-menu-note', run: onNote };
  return pause.hidden ? [note] : [toggle, note];
}

/** Moves focus between menu items with the arrow keys, Home and End (wrapping). */
function moveFocus(menu: HTMLElement, key: string): boolean {
  const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const index = key === 'Home' ? 0 : key === 'End' ? items.length - 1
    : key === 'ArrowDown' ? (at + 1) % items.length : key === 'ArrowUp' ? (at - 1 + items.length) % items.length : -1;
  items[index]?.focus();
  return index !== -1;
}

function ItemView({ item, first, onClose }: { item: MenuItem; first: boolean; onClose: () => void }) {
  const hintId = useId();
  const blocked = item.blocked !== undefined;
  return (
    <>
      <button type="button" role="menuitem" className={blocked ? 'agency-menu__item agency-menu__item--blocked' : 'agency-menu__item'}
        tabIndex={first ? 0 : -1} data-testid={item.testId} aria-disabled={blocked || undefined}
        aria-describedby={blocked ? hintId : undefined}
        onClick={() => {
          if (blocked) return;
          onClose();
          item.run();
        }}>{item.label}</button>
      {blocked ? <small id={hintId} className="agency-menu__hint">{item.blocked}</small> : null}
    </>
  );
}

function MenuView({ title, items, at, onClose }: { title: string; items: readonly MenuItem[]; at: ActorMenuAt; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.left = `${Math.max(EDGE, Math.min(at.x, window.innerWidth - node.offsetWidth - EDGE))}px`;
    node.style.top = `${Math.max(EDGE, Math.min(at.y, window.innerHeight - node.offsetHeight - EDGE))}px`;
    node.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [at.x, at.y]);

  useEffect(() => {
    // Capture phase: a press anywhere else closes the menu, even where a panel stops the event from bubbling.
    const onPress = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) closeRef.current();
    };
    document.addEventListener('pointerdown', onPress, true);
    return () => document.removeEventListener('pointerdown', onPress, true);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (ref.current && moveFocus(ref.current, event.key)) {
      event.preventDefault();
    }
  };

  return (
    <div ref={ref} className="agency-menu" role="menu" aria-label={title} onKeyDown={onKeyDown}>
      <p className="agency-menu__title" aria-hidden="true">{title}</p>
      {items.map((item, index) => <ItemView key={item.key} item={item} first={index === 0} onClose={onClose} />)}
    </div>
  );
}

function SessionMenu({ session, title, menu, details, onClose, onNote }: {
  session: SessionDTO; title: string; menu: ActorMenuAt; details: MenuItem; onClose: () => void; onNote: (at: ActorMenuAt) => void;
}) {
  const commands = useSessionCommands();
  const pause = usePause(session);
  const compact = useCompact(session);
  const note = () => onNote({ id: menu.id, x: menu.x, y: menu.y });
  const compactItem: MenuItem = { key: 'compact', label: `Compact now (${compact.pct ?? 0}% full)`, testId: 'actor-menu-compact', run: () => void compact.compact() };
  const items = [details, ...liveItems(pause, note), ...(compact.offer ? [compactItem] : []), ...sessionItems(session, commands)];
  return <MenuView key={`${menu.id}:${menu.x}:${menu.y}`} title={title} items={items} at={menu} onClose={onClose} />;
}

/** Right-click or press-and-hold menu for a character: Details, Pause or Resume, Send a note, Stop, Terminal, Restart. */
export function ActorMenu({ snapshot, menu, onClose, onDetails, onNote }: {
  snapshot: AgencySnapshot; menu: ActorMenuAt; onClose: () => void; onDetails: (id: string) => void; onNote: (at: ActorMenuAt) => void;
}) {
  const { state } = useStore();
  const navigate = useNavigate();
  const details: MenuItem = { key: 'details', label: 'Details', run: () => onDetails(menu.id) };

  if (menu.id === LUADY_ACTOR_ID) {
    const chat: MenuItem = { key: 'chat', label: 'Open chat', run: () => void navigate('/manager') };
    return <MenuView key={`${menu.x}:${menu.y}`} title={managerName()} items={[details, chat]} at={menu} onClose={onClose} />;
  }
  const actor = snapshot.actors[menu.id];
  if (actor === undefined) return null;
  const session = state.sessions.find((candidate) => candidate.id === menu.id);
  if (session === undefined) return <MenuView key={`${menu.id}:${menu.x}:${menu.y}`} title={actor.name} items={[details]} at={menu} onClose={onClose} />;
  return <SessionMenu session={session} title={actor.name} menu={menu} details={details} onClose={onClose} onNote={onNote} />;
}
