import { useStore } from '../../../state/store.js';
import { usePrefsUpdate } from '../model/usePrefsUpdate.js';
import { PixelIcon } from './PixelIcon.js';

/** The speaker in the top bar: one press (or M) mutes or unmutes the office's sounds on every device. */
export function SoundButton() {
  const { muted } = useStore().state.prefs.value.sound;
  const update = usePrefsUpdate();
  const label = muted ? 'Sounds off. Turn sounds on (M)' : 'Sounds on. Mute (M)';
  return (
    <button type="button" className={muted ? 'agency-sound agency-sound--muted' : 'agency-sound'} data-testid="sound-button"
      aria-label={label} title={label} onClick={() => void update({ sound: { muted: !muted } })}>
      <PixelIcon name={muted ? 'speakerOff' : 'speaker'} size={18} />
    </button>
  );
}
