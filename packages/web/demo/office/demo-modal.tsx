import { Suspense, lazy, useState } from 'react';
import { GiveProvider } from '../../src/features/agency/give/GiveContext.js';
import type { AgencyUiAction } from '../../src/features/agency/model/ui-state.js';
import { ModalFrame } from '../../src/features/agency/panels/ModalFrame.js';

const BoardModal = lazy(async () => ({ default: (await import('../../src/features/agency/drawers/board/BoardModal.js')).BoardModal }));
const NotesModal = lazy(async () => ({ default: (await import('../../src/features/agency/drawers/notes/NotesModal.js')).NotesModal }));

/**
 * Opens a pop-up over the office page: `?modal=board` (with `&card=24`) or `?modal=notes` (with
 * `&note=m:standup-1114`).
 */
export function DemoModal({ params }: { params: URLSearchParams }) {
  const kind = params.get('modal');
  const [open, setOpen] = useState(kind === 'board' || kind === 'notes');
  if (!open || (kind !== 'board' && kind !== 'notes')) return null;
  const close = () => setOpen(false);
  const card = params.get('card');
  const note = params.get('note');
  const log = (action: AgencyUiAction) => console.info('[demo] page action', action);
  return (
    <GiveProvider stage={null} dispatch={log}>
      <ModalFrame label={kind === 'board' ? 'Board' : 'Notes'} onClose={close}>
        <Suspense fallback={<p role="status">Opening…</p>}>
          {kind === 'board'
            ? <BoardModal {...(card === null ? {} : { itemId: Number(card) })} onClose={close} />
            : <NotesModal {...(note === null ? {} : { noteId: note })} onClose={close} />}
        </Suspense>
      </ModalFrame>
    </GiveProvider>
  );
}
