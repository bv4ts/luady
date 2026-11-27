import { ROOM_SPECIES, type RoomSpecies } from '@luady/shared';
import { useEffect, useRef, useState } from 'react';
import { drawCreature } from './creature-preview.js';

export const SPECIES_NAMES: Readonly<Record<RoomSpecies, string>> = Object.freeze({
  bun: 'Bun', bot: 'Bot', shield: 'Shield', ghost: 'Ghost', cat: 'Cat',
});

/** One creature, drawn in the room's colour; its name shows while the picture is not there (or cannot be drawn). */
export function CreaturePreview({ species, colour, size = 48 }: { species: RoomSpecies; colour: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return undefined;
    let alive = true;
    drawCreature(canvas, species, colour).then((ok) => {
      if (alive) setDrawn(ok);
    }, () => {
      if (alive) setDrawn(false);
    });
    return () => {
      alive = false;
    };
  }, [species, colour]);
  return (
    <span className="room-creature" data-drawn={drawn}>
      <canvas ref={ref} className="room-creature__art" width={24} height={24} style={{ width: size, height: size }} aria-hidden="true" />
      {drawn ? null : <span className="room-creature__name" aria-hidden="true">{SPECIES_NAMES[species]}</span>}
    </span>
  );
}

/** The five room creatures, each in the room's colour; arrow keys move between them. */
export function CreaturePicker({ value, colour, onChange }: { value: RoomSpecies; colour: string; onChange: (species: RoomSpecies) => void }) {
  const move = (step: number) => {
    const at = ROOM_SPECIES.indexOf(value);
    const next = ROOM_SPECIES[(at + step + ROOM_SPECIES.length) % ROOM_SPECIES.length];
    if (next !== undefined) onChange(next);
  };
  return (
    <fieldset className="room-creatures">
      <legend className="field__label">Creature</legend>
      <div role="radiogroup" aria-label="Creatures" className="room-creatures__list"
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(1); }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
        }}>
        {ROOM_SPECIES.map((species) => (
          <button key={species} type="button" role="radio" aria-checked={value === species} tabIndex={value === species ? 0 : -1}
            className="room-creatures__item" aria-label={SPECIES_NAMES[species]} onClick={() => onChange(species)}>
            <CreaturePreview species={species} colour={colour} size={40} />
            <span className="room-creatures__label">{SPECIES_NAMES[species]}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}
