import type { AgencySnapshot } from '@luady/office';
import type { Dispatch, ReactElement } from 'react';
import { AccountsDrawer } from './drawers/AccountsDrawer.js';
import { NoticesDrawer } from './drawers/NoticesDrawer.js';
import type { AccountsState } from './drawers/useAccounts.js';
import type { AgencyUi, AgencyUiAction } from './model/ui-state.js';
import type { NoticeAcks } from './model/useNoticeAcks.js';
import { AgentPanel } from './panels/AgentPanel.js';
import { LuadyPanel } from './panels/LuadyPanel.js';
import { PanelFrame } from './panels/PanelFrame.js';
import { RackPanel } from './panels/RackPanel.js';
import { RoomPanel } from './panels/RoomPanel.js';
import { managerName } from '@luady/shared';

interface PanelView {
  readonly label: string;
  readonly content: ReactElement;
}

/** What drawers need from the page (loaded once there). */
export interface PanelData {
  readonly accounts: AccountsState;
  readonly acks: NoticeAcks;
}

function panelView(ui: AgencyUi, snapshot: AgencySnapshot, dispatch: Dispatch<AgencyUiAction>, data: PanelData): PanelView | null {
  const room = ui.focus.kind === 'room' ? ui.focus.room : null;
  const def = room === null ? undefined : snapshot.map.rooms[room];
  switch (ui.panel) {
    case 'room':
      return room === null ? null : { label: `${def?.name ?? 'Room'} room`, content: <RoomPanel snapshot={snapshot} roomId={room} dispatch={dispatch} /> };
    case 'rack':
      return room === null ? null : { label: `Server ${def?.host ?? room}`, content: <RackPanel snapshot={snapshot} roomId={room} /> };
    case 'agent': {
      const id = ui.selectedId;
      if (id === null) return null;
      return { label: snapshot.actors[id]?.name ?? 'Agent', content: <AgentPanel snapshot={snapshot} actorId={id} /> };
    }
    case 'manager':
      return { label: managerName(), content: <LuadyPanel snapshot={snapshot} /> };
    case 'accounts':
      return { label: 'Accounts and limits', content: <AccountsDrawer accounts={data.accounts} /> };
    case 'notices':
      return { label: 'Notices', content: <NoticesDrawer acks={data.acks} onSelect={(id) => dispatch({ type: 'select', id })} /> };
    case null:
      return null;
  }
}

/** The one panel or drawer that is open, in its dock or sheet frame. */
export function OpenPanel({ ui, snapshot, dispatch, data }: {
  ui: AgencyUi; snapshot: AgencySnapshot; dispatch: Dispatch<AgencyUiAction>; data: PanelData;
}) {
  const view = panelView(ui, snapshot, dispatch, data);
  if (view === null) return null;
  return <PanelFrame label={view.label} onClose={() => dispatch({ type: 'close' })}>{view.content}</PanelFrame>;
}
