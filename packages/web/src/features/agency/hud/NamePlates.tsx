import type { AgencySnapshot } from '@luady/office';
import { memo, useCallback } from 'react';
import { teamStyle } from '../model/team-style.js';
import type { LabelView } from '../model/view-rooms.js';
import type { StageFocus } from '../stage-types.js';
import { plateList, type PlateInfo } from './plate-list.js';
import { placePlate, type PlateRegistry } from './plates.js';

function plateClass(info: PlateInfo): string {
  return ['agency-plate', info.guest ? 'agency-plate--guest' : null, info.needs ? 'agency-plate--needs' : null, info.tight ? 'agency-plate--tight' : null]
    .filter(Boolean).join(' ');
}

function Plate({ info, registry, onSelect }: { info: PlateInfo; registry: PlateRegistry; onSelect: (id: string) => void }) {
  const { id } = info;
  const register = useCallback((node: HTMLButtonElement | null) => {
    if (node === null) return undefined;
    registry.nodes.set(id, node);
    // Hidden until the stage says where the character is; a late plate takes the last known point at once.
    placePlate(node, registry.last.find((point) => point.id === id));
    return () => {
      if (registry.nodes.get(id) === node) registry.nodes.delete(id);
    };
  }, [id, registry]);

  return (
    <button ref={register} type="button" className={plateClass(info)} style={teamStyle(info.palette)} data-plate={info.luady ? 'manager' : 'agent'}
      aria-label={`${info.name}, ${info.words}`} onClick={() => onSelect(id)}>
      <span className="agency-plate__label" dir="auto">{info.name}</span>
    </button>
  );
}

/**
 * Name plates under the characters that matter now (see plateList), positioned from the stage's `onFrame` points
 * (see plates.ts); only for characters the scene draws (`view`). Re-renders only when the snapshot, the focus, the
 * selection or the labelled rooms change.
 */
export const NamePlates = memo(function NamePlates({ snapshot, focus, selectedId, registry, onSelect, view }: {
  snapshot: AgencySnapshot; focus: StageFocus; selectedId: string | null; registry: PlateRegistry; onSelect: (id: string) => void;
  view?: LabelView;
}) {
  return (
    <div className="agency-plates">
      {plateList(snapshot, focus, selectedId, view).map((info) => <Plate key={info.id} info={info} registry={registry} onSelect={onSelect} />)}
    </div>
  );
});
