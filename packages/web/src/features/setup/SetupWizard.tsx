import type { SetupStateDTO, SkippableSetupStep } from '@luady/shared';
import { useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { userMessage } from '../../api/errors.js';
import type { SetupApi } from '../../api/setup.js';
import { useWsMessage } from '../../api/ws.js';
import { Banner } from '../../ui/Banner.js';
import { useSetupApi, useSetupState } from './context.js';
import { SetupConnectBody } from './SetupConnect.js';
import { SetupExtrasBody } from './SetupExtras.js';
import { SetupFrame } from './SetupFrame.js';
import { SetupOpenBody } from './SetupOpen.js';
import { SetupRoomsBody } from './SetupRooms.js';
import { SETUP_PATH, allowedScreen, inWizard, wizardPath, type WizardScreen } from './steps.js';

const TITLES: Readonly<Record<WizardScreen, { title: string; intro: string }>> = {
  rooms: {
    title: 'Add your rooms',
    intro: 'One room is one server or one project. Add as many as you like; you can change them later in Settings.',
  },
  connect: {
    title: 'Connect your machines',
    intro: 'Each machine needs the kit (a small helper Luady installs in your home folder) and a Claude sign-in.',
  },
  extras: {
    title: 'Extras',
    intro: 'All optional, and all off unless you switch them on. You can change any of them later in Settings.',
  },
  open: {
    title: 'Open the office',
    intro: 'That is everything. Here is what is set up.',
  },
};

/** Follows `setup.changed` from the hub (another tab, a PIN set elsewhere). Mounted inside the live socket. */
export function SetupChanges() {
  const { apply } = useSetupState();
  useWsMessage('setup.changed', (message) => apply(message.state));
  return null;
}

/** While setup is not done, every page of the app leads to its current step (`/setup/<step>`). */
export function SetupGuard({ children }: { children: ReactNode }) {
  const { state } = useSetupState();
  const { pathname } = useLocation();
  const inSetup = pathname === SETUP_PATH || pathname.startsWith(`${SETUP_PATH}/`);
  if (inWizard(state) && !inSetup) return <Navigate to={wizardPath(state.step)} replace />;
  return <>{children}</>;
}

function useStepMover(state: SetupStateDTO) {
  const api = useSetupApi();
  const { apply } = useSetupState();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(call: (setup: SetupApi) => Promise<SetupStateDTO>, then: (next: SetupStateDTO) => string) {
    if (api === null) return setError('The setup could not load. Reload the page.');
    setBusy(true);
    setError(null);
    try {
      const next = await call(api);
      apply(next);
      navigate(then(next));
    } catch (err) {
      setError(`This step was not saved: ${userMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    error,
    move: (step: SkippableSetupStep, action: 'done' | 'skip') => {
      void run((setup) => setup.step({ step, action }), (next) => (step === 'extras' && inWizard(next) ? wizardPath('open') : inWizard(next) ? wizardPath(next.step) : '/'));
    },
    finish: () => {
      void run((setup) => setup.finish(), () => '/');
    },
    state,
  };
}

function WizardScreenView({ screen, state }: { screen: WizardScreen; state: SetupStateDTO }) {
  const mover = useStepMover(state);
  const text = TITLES[screen];
  const body = (() => {
    switch (screen) {
      case 'rooms': return <SetupRoomsBody onNext={(action) => mover.move('rooms', action)} />;
      case 'connect': return <SetupConnectBody onNext={(action) => mover.move('connect', action)} />;
      case 'extras': return <SetupExtrasBody onNext={(action) => mover.move('extras', action)} />;
      case 'open': return <SetupOpenBody state={state} busy={mover.busy} error={mover.error} onFinish={mover.finish} />;
    }
  })();
  return (
    <SetupFrame screen={screen} state={state} title={text.title} intro={<p>{text.intro}</p>} testId={`setup-${screen}`}>
      {screen !== 'open' && mover.error !== null ? <Banner tone="error">{mover.error}</Banner> : null}
      {body}
    </SetupFrame>
  );
}

/**
 * `/setup/*` inside the signed-in app: the steps after the PIN (rooms, connect, extras) and the summary that finishes.
 * An address ahead of the current step leads back to it; a finished setup leads to the office.
 */
export function SetupWizard() {
  const { state } = useSetupState();
  const asked = useParams()['*']?.split('/')[0];
  if (!inWizard(state)) return <Navigate to="/" replace />;
  const screen = allowedScreen(state, asked);
  if (screen === null) return <Navigate to="/" replace />;
  if (screen !== asked) return <Navigate to={wizardPath(screen)} replace />;
  return <WizardScreenView key={screen} screen={screen} state={state} />;
}
