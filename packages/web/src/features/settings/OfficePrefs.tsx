import { useEffect, useId, useRef, useState } from 'react';
import { usePrefsUpdate, type PrefsOutcome } from '../agency/model/usePrefsUpdate.js';
import { officeSound } from '../agency/sound/useOfficeSounds.js';
import { useStore } from '../../state/store.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { Switch } from '../../ui/Field.js';

/** A volume change goes to the hub once the slider rests this long. */
export const VOLUME_SAVE_MS = 400;

const HERE_ONLY = 'Saved on this page only: the hub keeps it after its next update.';

/** The words under the card after a change: nothing when it was saved for every device. */
const outcomeWords = (outcome: PrefsOutcome | null): string | null => (outcome === 'here' ? HERE_ONLY : null);

/** The volume slider: moves at once, saves when it rests, plays a sample at the new level. */
function VolumeField({ volume, muted, onSave }: { volume: number; muted: boolean; onSave: (volume: number) => void }) {
  const id = useId();
  const [value, setValue] = useState(Math.round(volume * 100));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setValue(Math.round(volume * 100));
  }, [volume]);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  const change = (next: number) => {
    setValue(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => onSave(next / 100), VOLUME_SAVE_MS);
  };
  const sample = () => {
    const engine = officeSound();
    engine.unlock();
    engine.play('ding', { muted: false, volume: value / 100, hidden: false });
  };
  return (
    <div className="field office-prefs__volume">
      <label className="field__label" htmlFor={id}>Volume</label>
      <div className="office-prefs__row">
        <input id={id} className="office-prefs__slider" type="range" min={0} max={100} step={5} value={value} disabled={muted}
          aria-valuetext={`${value}%`} onChange={(event) => change(Number(event.target.value))} />
        <output className="office-prefs__pct" htmlFor={id}>{value}%</output>
        <Button variant="secondary" size="sm" disabled={muted || value === 0} onClick={sample}>Play a sound</Button>
      </div>
    </div>
  );
}

/**
 * The office part of the settings: day and night, and the sounds. Kept by the hub so every device agrees;
 * the speaker in the office's top bar and the M key change the same mute.
 */
export function OfficePrefs() {
  const { value } = useStore().state.prefs;
  const update = usePrefsUpdate();
  const [note, setNote] = useState<string | null>(null);
  const save = (patch: Parameters<typeof update>[0]) => {
    void update(patch).then((outcome) => setNote(outcomeWords(outcome)));
  };
  return (
    <Card title="Office" subtitle="How the office looks and sounds, on every device." className="office-prefs">
      <div className="stack">
        <Switch label="Day and night" checked={value.dayNight} onChange={(dayNight) => save({ dayNight })}
          description="The office follows owner time: daylight by day, lamps at night, and HQ dims in your quiet hours." />
        <Switch label="Sounds" checked={!value.sound.muted} onChange={(on) => save({ sound: { muted: !on } })}
          description="Soft sounds for a new message, a finished card, something that needs you and a session arriving. M mutes them in the office." />
        <VolumeField volume={value.sound.volume} muted={value.sound.muted} onSave={(volume) => save({ sound: { volume } })} />
        {note === null ? null : <p className="text-subtle" role="status">{note}</p>}
      </div>
    </Card>
  );
}
