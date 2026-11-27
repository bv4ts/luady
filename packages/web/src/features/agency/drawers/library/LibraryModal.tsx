import type { LibraryDTO } from '@luady/shared';
import { useCallback, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useApi } from '../../../../api/context.js';
import { useStore } from '../../../../state/store.js';
import { useRooms } from '../../../rooms/useRooms.js';
import { KnowledgeTab } from './KnowledgeTab.js';
import { LIBRARY_NOT_READY, libraryError } from './library-error.js';
import { sortOffices } from './library-model.js';
import { ProjectsTab } from './ProjectsTab.js';
import { SkillsTab } from './SkillsTab.js';
import { useLoaded } from './useLoaded.js';
import './library.css';

export interface LibraryModalProps {
  readonly onClose: () => void;
}

type Tab = 'projects' | 'knowledge' | 'skills';
const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'projects', label: 'Projects' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'skills', label: 'Skills' },
];

/** The library in Luady HQ: every project per office, the knowledge pages and the skills. */
export function LibraryModal(_props: LibraryModalProps) {
  const api = useApi();
  const version = useStore().state.libraryVersion;
  const [tab, setTab] = useState<Tab>('projects');
  const baseId = useId();
  const lookup = useRooms();
  const { state, reload } = useLoaded(useCallback(() => api.library(), [api]), 'library', version);
  const library = useMemo<LibraryDTO | null>(
    () => (state.kind === 'ready' ? { ...state.value, offices: [...sortOffices(state.value.offices, lookup)] } : null),
    [state, lookup],
  );

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const at = TABS.findIndex((item) => item.id === tab);
    const next = TABS[(at + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    if (next === undefined) return;
    setTab(next.id);
    document.getElementById(`${baseId}-${next.id}`)?.focus();
  };

  return (
    <div className="lib" data-testid="library-modal">
      <div className="lib__tabs" role="tablist" aria-label="Library" onKeyDown={onTabKey}>
        {TABS.map((item) => (
          <button key={item.id} id={`${baseId}-${item.id}`} type="button" role="tab" className="lib__tab"
            aria-selected={tab === item.id} aria-controls={`${baseId}-panel`} tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      <section id={`${baseId}-panel`} className="lib__panel" role="tabpanel" aria-labelledby={`${baseId}-${tab}`}>
        {tab === 'knowledge' ? <KnowledgeTab library={library} />
          : state.kind === 'loading' ? <p className="lib__quiet" role="status">Taking the books off the shelves…</p>
            : state.kind === 'failed' ? <LibraryFailed text={libraryError(state.error)} onRetry={reload} />
              : library === null ? null
                : tab === 'projects' ? <ProjectsTab library={library} />
                  : <SkillsTab library={library} />}
      </section>
    </div>
  );
}

function LibraryFailed({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="lib__failed" role="alert">
      <p>{text}</p>
      {text === LIBRARY_NOT_READY ? null : <button type="button" className="lib__link" onClick={onRetry}>Try again</button>}
    </div>
  );
}
