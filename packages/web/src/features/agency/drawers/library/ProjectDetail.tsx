import type { KbPageDTO, LibraryProjectDTO } from '@luady/shared';
import { useCallback, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { useStore } from '../../../../state/store.js';
import { Icon } from '../../../../ui/Icon.js';
import { useOfficeNav } from '../../give/GiveContext.js';
import { useRooms } from '../../../rooms/useRooms.js';
import { teamStyle } from '../../model/team-style.js';
import { whenText } from '../account-text.js';
import { libraryError } from './library-error.js';
import { officeName, officePalette, projectCounts, projectSessions, shortFolder } from './library-model.js';
import { useProjectsRoot } from './useProjectsRoot.js';
import { PageReader } from './PageReader.js';
import { AddCardForm, NewSessionForm } from './ProjectForms.js';
import { useLoaded } from './useLoaded.js';

const STATE_WORDS: Readonly<Record<string, string>> = {
  starting: 'starting', idle: 'idle', working: 'working', waiting_question: 'has a question', waiting_permission: 'asks permission',
  error: 'stopped with an error', ended: 'ended',
};

/** A project opened: its facts, its knowledge pages, its sessions, and "New session here" / "Add a card". */
export function ProjectDetail({ project, onBack }: { project: LibraryProjectDTO; onBack: () => void }) {
  const api = useApi();
  const { state } = useStore();
  const lookup = useRooms();
  const root = useProjectsRoot(project.server);
  const [reading, setReading] = useState<number | null>(null);
  const [form, setForm] = useState<'session' | 'card' | null>(null);
  const nav = useOfficeNav();
  const pages = useLoaded(
    useCallback(() => api.kbPages({ scope: 'project', server: project.server, project: project.name }), [api, project.server, project.name]),
    `${project.server}/${project.name}`,
    state.kbVersion,
  );
  const sessions = projectSessions(state.sessions, project);
  const last = project.commits[0];

  return (
    <article className="lib-detail" style={teamStyle(officePalette(project.server, lookup))} aria-label={project.name}>
      <button type="button" className="lib__back" onClick={onBack}><Icon name="back" /> All projects</button>
      <header className="lib-detail__head">
        <p className="lib-detail__office">{officeName(project.server, lookup)}</p>
        <h3 className="lib-detail__title" dir="auto">{project.name}</h3>
        <dl className="lib-facts">
          <div><dt>Folder</dt><dd className="lib-mono">{shortFolder(project.path, root)}</dd></div>
          {project.branch === null ? null : <div><dt>Branch</dt><dd className="lib-mono">{project.branch}</dd></div>}
          {last === undefined ? null : <div><dt>Last commit</dt><dd dir="auto">{last.subject} · {whenText(last.date, new Date())}</dd></div>}
          {project.stack.length === 0 ? null : <div><dt>Stack</dt><dd>{project.stack.join(', ')}</dd></div>}
          <div><dt>Now</dt><dd>{projectCounts(project)}</dd></div>
        </dl>
        <div className="lib-detail__actions">
          <button type="button" className="lib-btn lib-btn--brass" aria-expanded={form === 'session'} onClick={() => setForm(form === 'session' ? null : 'session')}>
            <Icon name="plus" /> New session here
          </button>
          <button type="button" className="lib-btn" aria-expanded={form === 'card'} onClick={() => setForm(form === 'card' ? null : 'card')}>
            <Icon name="plus" /> Add a card
          </button>
        </div>
        {form === 'session' ? <NewSessionForm project={project} onDone={() => setForm(null)} /> : null}
        {form === 'card' ? <AddCardForm project={project} onDone={() => setForm(null)} /> : null}
      </header>

      <section className="lib-detail__part" aria-label="Knowledge pages">
        <h4 className="lib-detail__sub">Knowledge pages</h4>
        {pages.state.kind === 'loading' ? <p className="lib__quiet" role="status">Loading pages…</p> : null}
        {pages.state.kind === 'failed' ? <p className="lib__quiet" role="alert">{libraryError(pages.state.error)}</p> : null}
        {pages.state.kind === 'ready' ? <PageList pages={pages.state.value.items} reading={reading} onRead={setReading} /> : null}
        {reading === null ? null : <PageReader id={reading} onClose={() => setReading(null)} />}
      </section>

      <section className="lib-detail__part" aria-label="Sessions">
        <h4 className="lib-detail__sub">Sessions on it now</h4>
        {sessions.length === 0 ? <p className="lib__quiet">No session works on this project. Start one with "New session here".</p> : (
          <ul className="lib-sessions">
            {sessions.map((session) => (
              <li key={session.id} className={`lib-session lib-session--${session.state}`}>
                <span className="lib-session__dot" aria-hidden="true" />
                {nav === null ? <span dir="auto">{session.displayName}</span> : (
                  <button type="button" className="lib-session__open" aria-label={`Open ${session.displayName}`} onClick={() => nav.openAgent(session.id)}>
                    <span dir="auto">{session.displayName}</span>
                  </button>
                )}
                <span className="lib-session__state">{STATE_WORDS[session.state] ?? session.state}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

function PageList({ pages, reading, onRead }: { pages: readonly KbPageDTO[]; reading: number | null; onRead: (id: number) => void }) {
  if (pages.length === 0) return <p className="lib__quiet">No pages for this project yet. Add one in Knowledge.</p>;
  return (
    <ul className="lib-pagelist">
      {pages.map((page) => (
        <li key={page.id}>
          <button type="button" className="lib-pagelist__item" aria-pressed={reading === page.id} onClick={() => onRead(page.id)}>
            <Icon name="book" /> <span dir="auto">{page.title}</span>{page.pinned ? <span className="lib-chip">pinned</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
