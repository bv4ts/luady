import type { SetupStateDTO } from '@luady/shared';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { BrandMark } from '../../ui/BrandMark.js';
import { SCREENS, allowedScreen, isWizardScreen, screenIndex, wizardPath, type SetupScreen } from './steps.js';
import '@fontsource/pixelify-sans/latin-600.css';
import './setup.css';

/** Where the owner is: every step by name; done ones ticked, skipped ones said, reachable wizard steps as links. */
export function SetupSteps({ current, state }: { current: SetupScreen; state: SetupStateDTO | null }) {
  const at = screenIndex(current);
  return (
    <nav className="setup-steps" aria-label="Setup steps">
      <p className="setup-steps__count">Step {at + 1} of {SCREENS.length}</p>
      <ol className="setup-steps__list">
        {SCREENS.map((info, i) => {
          const skipped = state !== null && state.skipped.some((step) => step === info.id || (info.id === 'claim' && step === 'passkey'));
          const status = i === at ? 'current' : i < at ? (skipped ? 'skipped' : 'done') : 'later';
          const reachable = state !== null && i !== at && isWizardScreen(info.id) && allowedScreen(state, info.id) === info.id;
          const label = (
            <>
              <span className="setup-steps__mark" aria-hidden="true">{status === 'done' ? '✓' : i + 1}</span>
              <span className="setup-steps__label">{info.label}</span>
              {status === 'skipped' ? <span className="setup-steps__note"> (skipped)</span> : null}
              {status === 'done' ? <span className="visually-hidden"> (done)</span> : null}
            </>
          );
          return (
            <li key={info.id} className={`setup-steps__item is-${status}`} aria-current={i === at ? 'step' : undefined}>
              {reachable && isWizardScreen(info.id)
                ? <Link className="setup-steps__inner" to={wizardPath(info.id)}>{label}</Link>
                : <span className="setup-steps__inner">{label}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface SetupFrameProps {
  readonly screen: SetupScreen;
  readonly state: SetupStateDTO | null;
  readonly title: string;
  /** One or two plain sentences: what this screen decides. */
  readonly intro: ReactNode;
  readonly testId: string;
  readonly children: ReactNode;
}

/**
 * The first run's page: the office's dusk look, the step list, and one decision per screen. The heading takes the focus
 * when the screen changes, so a keyboard or screen-reader user starts at the top of the new step.
 */
export function SetupFrame({ screen, state, title, intro, testId, children }: SetupFrameProps) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [screen]);
  return (
    <main className="setup-page" data-testid="setup-page">
      <div className="setup-page__inner">
        <header className="setup-head">
          <BrandMark size={36} />
          <span className="setup-head__name">Luady setup</span>
        </header>
        <SetupSteps current={screen} state={state} />
        <section className="setup-card stack" aria-labelledby={headingId} data-testid={testId}>
          <h1 className="setup-card__title" id={headingId} ref={heading} tabIndex={-1}>{title}</h1>
          <div className="setup-card__intro">{intro}</div>
          {children}
        </section>
      </div>
    </main>
  );
}
