import { LIMITS, isHostId, isSelfHost, type KbPageFullDTO, type KbScope, type LibraryDTO } from '@luady/shared';
import { useId, useMemo, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import type { CreateKbPageInput } from '../../../../api/kb.js';
import { Markdown } from '../../../../markdown/Markdown.js';
import { useRooms, type RoomLookup } from '../../../rooms/useRooms.js';
import { libraryError } from './library-error.js';
import { compareOffices, officeHosts, officeName, parseTags } from './library-model.js';
import { scopeText } from './PageReader.js';

/** The offices a page can be for: every room's host and every host the library lists, in reading order. */
function officeChoices(library: LibraryDTO | null, lookup: RoomLookup): readonly string[] {
  const hosts = [...officeHosts(lookup), ...(library?.offices.map((office) => office.server) ?? [])].filter((host) => !isSelfHost(host));
  return [...new Set(hosts)].toSorted(compareOffices(lookup));
}

export interface PageEditorProps {
  readonly library: LibraryDTO | null;
  /** The page being edited; null writes a new one. */
  readonly page: KbPageFullDTO | null;
  readonly onSaved: (page: KbPageFullDTO) => void;
  readonly onCancel: () => void;
}

interface Draft {
  readonly title: string;
  readonly body: string;
  readonly tags: string;
  readonly scope: KbScope;
  readonly server: string;
  readonly project: string;
}

type DraftErrors = Partial<Record<'title' | 'body' | 'server' | 'project', string>>;

const SCOPES: readonly { value: KbScope; label: string }[] = [
  { value: 'global', label: 'Everyone' },
  { value: 'office', label: 'One office' },
  { value: 'project', label: 'One project' },
];

/** What the form is missing, in plain words. */
export function draftErrors(draft: Draft): DraftErrors {
  return {
    ...(draft.title.trim() === '' ? { title: 'Give the page a title.' } : {}),
    ...(draft.body.length > LIMITS.kbBodyMax ? { body: 'Keep the page under 60,000 characters.' } : {}),
    ...(draft.scope !== 'global' && draft.server === '' ? { server: 'Choose the office.' } : {}),
    ...(draft.scope === 'project' && draft.project.trim() === '' ? { project: 'Choose the project.' } : {}),
  };
}

/** The create body for a new page: server and project only where the scope needs them. */
export function createBody(draft: Draft): CreateKbPageInput {
  const tags = parseTags(draft.tags);
  return {
    scope: draft.scope,
    ...(draft.scope !== 'global' && draft.server !== '' ? { server: draft.server } : {}),
    ...(draft.scope === 'project' ? { project: draft.project.trim() } : {}),
    title: draft.title.trim(),
    body: draft.body,
    ...(tags.length > 0 ? { tags } : {}),
  };
}

const initial = (page: KbPageFullDTO | null): Draft => ({
  title: page?.title ?? '', body: page?.body ?? '', tags: page?.tags.join(', ') ?? '',
  scope: page?.scope ?? 'global', server: page?.server ?? '', project: page?.project ?? '',
});

/** Add or edit a page: title, where it applies, tags, and a Markdown box with its preview beside (or a tab on a phone). */
export function PageEditor({ library, page, onSaved, onCancel }: PageEditorProps) {
  const api = useApi();
  const lookup = useRooms();
  const offices = useMemo(() => officeChoices(library, lookup), [library, lookup]);
  const [draft, setDraft] = useState<Draft>(() => initial(page));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'write' | 'preview'>('write');
  const id = useId();
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const projects = library?.offices.find((office) => office.server === draft.server)?.projects ?? [];

  async function save() {
    const found = draftErrors(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setFailure(null);
    setBusy(true);
    try {
      const saved = page === null
        ? await api.createKbPage(createBody(draft))
        : await api.updateKbPage(page.id, { title: draft.title.trim(), body: draft.body, tags: parseTags(draft.tags) });
      onSaved(saved);
    } catch (err) {
      setFailure(libraryError(err));
      setBusy(false);
    }
  }

  return (
    <form className="lib-editor" aria-label={page === null ? 'New page' : `Edit ${page.title}`} noValidate
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h3 className="lib-reader__title">{page === null ? 'A new page' : 'Edit the page'}</h3>
      <label className="lib-form__label" htmlFor={`${id}-title`}>Title</label>
      <input id={`${id}-title`} className="lib-input" dir="auto" maxLength={LIMITS.kbTitleMax} value={draft.title}
        aria-invalid={errors.title === undefined ? undefined : true} onChange={(event) => update('title', event.target.value)} />
      {errors.title === undefined ? null : <p className="lib-form__error" role="alert">{errors.title}</p>}

      {page === null ? (
        <fieldset className="lib-editor__where">
          <legend className="lib-form__label">Who reads it</legend>
          <div className="lib-editor__scopes">
            {SCOPES.map((scope) => (
              <label key={scope.value} className="lib-radio">
                <input type="radio" name={`${id}-scope`} value={scope.value} checked={draft.scope === scope.value}
                  onChange={() => update('scope', scope.value)} /> {scope.label}
              </label>
            ))}
          </div>
          {draft.scope === 'global' ? null : (
            <>
              <label className="lib-form__label" htmlFor={`${id}-server`}>Office</label>
              <select id={`${id}-server`} className="lib-input" value={draft.server} aria-invalid={errors.server === undefined ? undefined : true}
                onChange={(event) => setDraft((current) => ({ ...current, server: isHostId(event.target.value) ? event.target.value : '', project: '' }))}>
                <option value="">Choose…</option>
                {offices.map((server) => <option key={server} value={server}>{officeName(server, lookup)}</option>)}
              </select>
              {errors.server === undefined ? null : <p className="lib-form__error" role="alert">{errors.server}</p>}
            </>
          )}
          {draft.scope === 'project' ? (
            <>
              <label className="lib-form__label" htmlFor={`${id}-project`}>Project</label>
              {projects.length > 0 ? (
                <select id={`${id}-project`} className="lib-input" value={draft.project} aria-invalid={errors.project === undefined ? undefined : true}
                  onChange={(event) => update('project', event.target.value)}>
                  <option value="">Choose…</option>
                  {projects.map((project) => <option key={project.path} value={project.name}>{project.name}</option>)}
                </select>
              ) : (
                <input id={`${id}-project`} className="lib-input" value={draft.project} maxLength={LIMITS.boardProjectMax} placeholder="Project name"
                  aria-invalid={errors.project === undefined ? undefined : true} onChange={(event) => update('project', event.target.value)} />
              )}
              {errors.project === undefined ? null : <p className="lib-form__error" role="alert">{errors.project}</p>}
            </>
          ) : null}
        </fieldset>
      ) : <p className="lib-reader__scope">For {scopeText(page, lookup)}</p>}

      <label className="lib-form__label" htmlFor={`${id}-tags`}>Tags <span className="lib-form__opt">(comma between them)</span></label>
      <input id={`${id}-tags`} className="lib-input" dir="auto" value={draft.tags} onChange={(event) => update('tags', event.target.value)} />

      <div className="lib-editor__switch" role="group" aria-label="Write or preview">
        <button type="button" className="lib-tab lib-tab--small" aria-pressed={view === 'write'} onClick={() => setView('write')}>Write</button>
        <button type="button" className="lib-tab lib-tab--small" aria-pressed={view === 'preview'} onClick={() => setView('preview')}>Preview</button>
      </div>
      <div className="lib-editor__panes" data-view={view}>
        <div className="lib-editor__pane lib-editor__pane--write">
          <label className="lib-visually-hidden" htmlFor={`${id}-body`}>Page text (Markdown)</label>
          <textarea id={`${id}-body`} className="lib-input lib-input--area lib-editor__body" dir="auto" value={draft.body}
            placeholder={'# What every session should know\n\n- Run the tests before a commit'}
            aria-invalid={errors.body === undefined ? undefined : true} onChange={(event) => update('body', event.target.value)} />
        </div>
        <div className="lib-editor__pane lib-editor__pane--preview" aria-label="Preview">
          {draft.body.trim() === '' ? <p className="lib__quiet">The preview shows here.</p> : <Markdown source={draft.body} className="lib-reader__body" />}
        </div>
      </div>
      {errors.body === undefined ? null : <p className="lib-form__error" role="alert">{errors.body}</p>}
      {failure === null ? null : <p className="lib-form__error" role="alert">{failure}</p>}
      <div className="lib-form__row">
        <button type="submit" className="lib-btn lib-btn--brass" disabled={busy}>{busy ? 'Saving…' : 'Save page'}</button>
        <button type="button" className="lib-btn lib-btn--quiet" onClick={onCancel}>Cancel</button>
        <span className="lib-form__opt">{draft.body.length.toLocaleString('en-US')} characters</span>
      </div>
    </form>
  );
}
