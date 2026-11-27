import { DEFAULT_ROOM_PALETTE, ROOM_WARN_DELTA_E, deltaE2000, nearReserved, normaliseHex, type RoomDTO } from '@luady/shared';
import { useId, type CSSProperties } from 'react';
import { savedColour } from './room-form.js';

/** A swatch colour as a CSS custom property (set through the CSSOM, which the CSP allows). */
const swatch = (hex: string): CSSProperties => ({ '--swatch': hex }) as CSSProperties;

/** The reserved colours by what the owner sees them as. */
const RESERVED_WORDS: Readonly<Record<string, string>> = Object.freeze({
  headquarters: 'HQ’s teal', mute: 'the grey of paused agents', alert: 'the red of alerts', warn: 'the amber of warnings', ok: 'the green of “all good”',
});

/** What to know about a colour before saving: close to a reserved colour, or to another room's. */
export function colourWarnings(hex: string, rooms: readonly RoomDTO[], self: string | null): readonly string[] {
  const reserved = nearReserved(hex).map((hit) => `It looks like ${RESERVED_WORDS[hit.name] ?? 'a colour the office uses'}.`);
  const near = rooms.filter((room) => room.id !== self && deltaE2000(hex, room.colour) < ROOM_WARN_DELTA_E)
    .map((room) => `It looks like ${room.name}’s colour.`);
  return [...reserved, ...near];
}

const nameOfHex = (hex: string): string | null => DEFAULT_ROOM_PALETTE.find((entry) => entry.hex === hex)?.name ?? null;

/**
 * Twelve named swatches and a custom colour. It shows the colour the room will really get (clamped
 * into the readable range) and any warning; a warning never stops a save.
 */
export function ColourPicker({ value, rooms, self, onChange }: {
  value: string; rooms: readonly RoomDTO[]; self: string | null; onChange: (hex: string) => void;
}) {
  const id = useId();
  const saved = savedColour({ colour: value });
  const picked = normaliseHex(value);
  const warnings = saved === null ? [] : colourWarnings(saved.hex, rooms, self);
  return (
    <fieldset className="room-colour" aria-describedby={`${id}-now`}>
      <legend className="field__label">Colour</legend>
      <div className="room-colour__swatches" role="radiogroup" aria-label="Room colours">
        {DEFAULT_ROOM_PALETTE.map((entry) => (
          <button key={entry.hex} type="button" role="radio" aria-checked={picked === entry.hex} className="room-swatch"
            aria-label={entry.name} title={entry.name} data-hex={entry.hex} style={swatch(entry.hex)}
            onClick={() => onChange(entry.hex)}>
            {picked === entry.hex ? <span className="room-swatch__tick" aria-hidden="true">✓</span> : null}
          </button>
        ))}
      </div>
      <label className="room-colour__custom">
        <span>Or your own</span>
        <input className="input input--mono" value={value} maxLength={7} spellCheck={false} autoCapitalize="off" aria-label="Your own colour, like #3d7bff"
          onChange={(event) => onChange(event.target.value)} />
      </label>
      <p className="field__hint" id={`${id}-now`} role="status">
        {saved === null ? 'Type a colour like #3d7bff.' : (
          <>
            <span className="room-colour__dot" aria-hidden="true" style={swatch(saved.hex)} />
            {` The room will be ${nameOfHex(saved.hex) ?? saved.hex}.`}
            {saved.adjusted ? ' It was made a little lighter or darker so its creatures stay readable on the floor.' : ''}
          </>
        )}
      </p>
      {warnings.map((warning) => <p key={warning} className="room-note room-note--warn">{warning} You can keep it, or pick another.</p>)}
    </fieldset>
  );
}
