import type { AgencySnapshot } from '@luady/office';
import type { Dispatch } from 'react';
import { useStore } from '../../../state/store.js';
import { pickEnergy } from '../model/energy.js';
import { focusedRoom } from '../model/focus.js';
import type { AgencyUi, AgencyUiAction } from '../model/ui-state.js';
import { EnergyBar } from './EnergyBar.js';
import { NoticesButton } from './NoticesButton.js';
import { SoundButton } from './SoundButton.js';
import { UpdatesPill } from './UpdatesPill.js';

/**
 * The notices button, the energy bar (the focused room's account, else the fullest), the where-updates-go pill and the
 * speaker.
 */
export function TopBarExtras({ snapshot, ui, dispatch }: { snapshot: AgencySnapshot; ui: AgencyUi; dispatch: Dispatch<AgencyUiAction> }) {
  const { state } = useStore();
  const room = focusedRoom(snapshot, ui.focus);
  const host = room === null ? null : (snapshot.map.rooms[room]?.host ?? null);
  const energy = pickEnergy(state.accounts?.accounts ?? [], host);
  return (
    <>
      <NoticesButton onOpen={() => dispatch({ type: 'open', panel: 'notices' })} />
      <EnergyBar energy={energy} onOpen={() => dispatch({ type: 'open', panel: 'accounts' })} />
      <UpdatesPill />
      <SoundButton />
    </>
  );
}
