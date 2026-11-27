import { furnitureRaster, type FixtureKind } from '@luady/office';
import { memo, useEffect, useMemo, useRef } from 'react';
import type { StageTarget } from '../../stage-types.js';
import { useRooms } from '../../../rooms/useRooms.js';
import { HELP_KEYS, helpFixtures, type HelpFixture } from './help-content.js';
import { WHATS_NEW } from './whats-new.js';
import './help.css';

export interface HelpModalProps {
  readonly onClose: () => void;
  /** "Show me": closes the pop-up and flies the camera to that fixture, room or character. */
  readonly onShow: (target: StageTarget) => void;
}

/** The fixture's own pixels from the map, drawn on a small canvas (nothing without a 2D canvas). */
const FixturePicture = memo(function FixturePicture({ kind }: { kind: FixtureKind }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const raster = useMemo(() => furnitureRaster(kind), [kind]);
  useEffect(() => {
    const context = ref.current?.getContext('2d') ?? null;
    if (context === null) return;
    context.putImageData(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height), 0, 0);
  }, [raster]);
  return (
    <span className="help-fixture__frame" aria-hidden="true">
      <canvas ref={ref} className="help-fixture__picture" width={raster.width} height={raster.height} data-wide={raster.width > raster.height * 2.5} />
    </span>
  );
});

function FixtureCard({ fixture, onShow }: { fixture: HelpFixture; onShow: (target: StageTarget) => void }) {
  const { target } = fixture;
  return (
    <li className="help-fixture">
      <FixturePicture kind={fixture.kind} />
      <span className="help-fixture__text">
        <span className="help-fixture__title">{fixture.title}<span className="help-fixture__where">{fixture.where}</span></span>
        <span className="help-fixture__line">{fixture.line}</span>
      </span>
      {fixture.kind === 'robot' || target === null ? null : (
        <button type="button" className="help-fixture__show" aria-label={`Show me the ${fixture.title.toLowerCase()}`}
          onClick={() => onShow(target)}>Show me</button>
      )}
    </li>
  );
}

const dateWords = (day: string): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(Date.parse(`${day}T00:00:00Z`));

/** Help: every fixture with its picture and "Show me", the keys, and what is new. */
export function HelpModal({ onShow }: HelpModalProps) {
  const first = useRooms().firstRoom();
  const fixtures = useMemo(() => helpFixtures(first), [first]);
  return (
    <div className="help" data-testid="help-modal">
      <section className="help__section" aria-labelledby="help-office">
        <h3 id="help-office" className="agency-title help__title">In the office</h3>
        <p className="help__lead">Press any of these on the map to open it.</p>
        <ul className="help__fixtures">
          {fixtures.map((fixture) => <FixtureCard key={fixture.kind} fixture={fixture} onShow={onShow} />)}
        </ul>
      </section>
      <div className="help__side">
        <section className="help__section" aria-labelledby="help-keys">
          <h3 id="help-keys" className="agency-title help__title">Keys</h3>
          <dl className="help__keys">
            {HELP_KEYS.map((key) => (
              <div key={key.does} className="help__key">
                <dt>{key.keys.map((part) => (part === '–' ? <span key={part}> to </span> : <kbd key={part}>{part}</kbd>))}</dt>
                <dd>{key.does}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="help__section" aria-labelledby="help-new">
          <h3 id="help-new" className="agency-title help__title">What’s new</h3>
          {WHATS_NEW.map((entry) => (
            <article key={entry.title} className="help__news">
              <h4 className="help__news-title">{entry.title} <time dateTime={entry.date}>{dateWords(entry.date)}</time></h4>
              <ul className="help__news-items">{entry.items.map((item) => <li key={item}>{item}</li>)}</ul>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}
