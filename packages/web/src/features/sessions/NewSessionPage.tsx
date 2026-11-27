import { Link } from 'react-router';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { SelectField, TextAreaField, TextField } from '../../ui/Field.js';
import { Icon } from '../../ui/Icon.js';
import { PROMPT_MAX, folderHint, normalizeFolder, suggestName } from './new-session.js';
import { useNewSessionForm } from './useNewSessionForm.js';
import './sessions.css';

const TYPED = '__typed__';

export function NewSessionPage() {
  const { form, errors, busy, failure, projects, servers, root, hostLabel, update, pickServer, submit } = useNewSessionForm();
  const folder = normalizeFolder(form.cwd);
  const projectValue = projects.projects.some((p) => p.path === folder) ? folder : TYPED;
  const projectOptions = [
    { value: TYPED, label: projects.loading ? 'Loading projects…' : 'Type a folder below' },
    ...projects.projects.map((p) => ({ value: p.path, label: p.branch ? `${p.name} (${p.branch})` : p.name })),
  ];
  const serverOptions = servers.length > 0
    ? servers.map((server) => ({ value: server.name, label: `${hostLabel(server.name)} · ${server.status}` }))
    : [{ value: '', label: 'No servers yet' }];
  const tmuxName = form.name.trim() || suggestName(form.cwd) || 'name';

  return (
    <div className="page page--narrow">
      <header className="page-header">
        <div className="row">
          <Link to="/sessions" className="btn btn--ghost btn--icon btn--sm" aria-label="Back to sessions"><Icon name="back" /></Link>
          <h1>New session</h1>
        </div>
      </header>
      <form className="card stack stack--lg" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <SelectField label="Server" value={form.server} options={serverOptions} error={errors.server}
          onChange={(event) => pickServer(event.target.value)} />
        <SelectField label="Project" value={projectValue} options={projectOptions}
          hint={projects.error ? `Couldn't load projects: ${projects.error}` : root === null ? 'Git repositories on this server.' : `Git repositories under ${root}.`}
          onChange={(event) => { if (event.target.value !== TYPED) update('cwd', event.target.value); }} />
        <TextField label="Folder" className="input--mono" placeholder={`${root ?? '/path/to'}/my-project`} value={form.cwd}
          error={errors.cwd} hint={folderHint(root)} autoCapitalize="off" autoCorrect="off" spellCheck={false}
          onChange={(event) => update('cwd', event.target.value)} />
        <TextField label="Session name (optional)" placeholder={suggestName(form.cwd) || 'my-feature'} value={form.name}
          error={errors.name} hint={`Runs in tmux as cc-${tmuxName}.`} autoCapitalize="off" spellCheck={false}
          onChange={(event) => update('name', event.target.value)} />
        <TextAreaField label="First prompt (optional)" rows={5} value={form.prompt} error={errors.prompt} maxLength={PROMPT_MAX}
          dir="auto" onChange={(event) => update('prompt', event.target.value)} />
        {failure ? <Banner tone="error">{failure}</Banner> : null}
        <div className="row row--end">
          <Link to="/sessions" className="btn btn--ghost">Cancel</Link>
          <Button type="submit" variant="primary" icon="play" busy={busy}>Start session</Button>
        </div>
      </form>
    </div>
  );
}
