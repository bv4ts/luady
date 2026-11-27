import { hiddenNote, type PermissionPreview, type QuestionDTO } from '@luady/shared';
import { useMemo } from 'react';
import { diffLines, type DiffLine } from './preview-diff.js';

/** What the kit writes where it removed a secret. */
const REDACTED = '[redacted]';
const GUTTER: Readonly<Record<DiffLine['kind'], string>> = Object.freeze({ same: ' ', removed: '−', added: '+', gap: '⋯' });

function EditDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  return (
    <div className="diff" role="group" aria-label="Changed lines">
      {lines.map((line, index) => (
        <div key={index} className={`diff__row diff__row--${line.kind}`}>
          <span className="diff__gutter" aria-hidden="true">{GUTTER[line.kind]}</span>
          <span className="diff__text">{line.kind === 'removed' ? <del>{line.text}</del> : line.kind === 'added' ? <ins>{line.text}</ins> : line.text}</span>
        </div>
      ))}
    </div>
  );
}

function CommandView({ command, cwd }: { command: string; cwd: string | null }) {
  return (
    <>
      <pre className="approval-preview__command">{command}</pre>
      {cwd === null ? null : <p className="approval-preview__where mono">{`in ${cwd}`}</p>}
    </>
  );
}

/** A file inside the folder the session runs in is named from there (the folder on its own line); any other in full. */
export function filePlace(path: string, cwd: string | null): { readonly name: string; readonly folder: string | null } {
  const base = cwd === null ? null : cwd.replace(/\/+$/, '');
  if (base === null || base === '' || !path.startsWith(`${base}/`) || path.length === base.length + 1) return { name: path, folder: null };
  return { name: path.slice(base.length + 1), folder: base };
}

function FileView({ preview }: { preview: PermissionPreview }) {
  const place = preview.path === null ? null : filePlace(preview.path, preview.cwd);
  return (
    <>
      {place === null ? null : <p className="approval-preview__path mono" title={preview.path ?? undefined}>{place.name}</p>}
      {place?.folder == null ? null : <p className="approval-preview__where mono">{`in ${place.folder}`}</p>}
      {preview.edits.map((edit, index) => <EditDiff key={index} oldText={edit.old} newText={edit.new} />)}
    </>
  );
}

function Body({ preview, fallback }: { preview: PermissionPreview | null; fallback: string }) {
  if (preview?.kind === 'command' && preview.command !== null) return <CommandView command={preview.command} cwd={preview.cwd} />;
  if ((preview?.kind === 'edit' || preview?.kind === 'write') && preview.edits.length > 0) return <FileView preview={preview} />;
  return fallback === '' ? null : <pre className="approval-preview__command">{fallback}</pre>;
}

/** True when the kit removed a secret somewhere in what the owner is shown. */
function hidesSecret(preview: PermissionPreview | null, fallback: string): boolean {
  const texts = preview === null ? [fallback] : [preview.command ?? '', fallback, ...preview.edits.flatMap((e) => [e.old, e.new])];
  return texts.some((text) => text.includes(REDACTED));
}

/**
 * The exact command or the changed lines of a permission request (kit 2), in a box with its own scrolling so the
 * buttons under it stay in view. A kit-1 request, or a tool without a structured preview, shows the old text.
 * A cut or redacted preview says so in words; one that offers no Allow says to answer it in the terminal.
 */
export function ApprovalPreview({ permission, allowOffered = true }: {
  permission: NonNullable<QuestionDTO['permission']>;
  allowOffered?: boolean;
}) {
  const preview = permission.preview ?? null;
  const fallback = permission.inputPreview;
  return (
    <>
      <div className="approval-preview" data-testid="approval-preview" tabIndex={0} role="region" aria-label="What it wants to do">
        <Body preview={preview} fallback={fallback} />
      </div>
      {!allowOffered ? <p className="approval-note">{hiddenNote(permission)}</p> : null}
      {allowOffered && preview?.truncated === true ? <p className="approval-note">Cut to fit. Open the terminal to see all of it.</p> : null}
      {allowOffered && hidesSecret(preview, fallback) ? <p className="approval-note">Part of this command is hidden.</p> : null}
    </>
  );
}
