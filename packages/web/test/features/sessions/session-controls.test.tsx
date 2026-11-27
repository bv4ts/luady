import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Composer } from '../../../src/features/sessions/Composer.js';
import { SessionControls } from '../../../src/features/sessions/SessionControls.js';
import { action, activityItem, overview, server, session } from '../../fixtures.js';
import { fakeApi } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';

const SID = 'cedar:cc-meadow-hr:0.0';
const kit2 = () => overview({ servers: [server({ kitVersion: '2.0.0' })], sessions: [session({ state: 'working' })] });

function Both() {
  const current = session({ state: 'working' });
  return (
    <>
      <SessionControls session={current} />
      <Composer session={current} disabledReason={null} />
    </>
  );
}

describe('SessionControls: pause and resume', () => {
  it('pauses from the classic page', async () => {
    const api = fakeApi({ pauseSession: async () => action({ kind: 'session.pause', tier: 0, status: 'done', result: 'paused' }) });
    const { user } = await renderPage(<Both />, { api, overview: kit2() });
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(api.pauseSession).toHaveBeenCalledWith(SID);
    expect(await screen.findByText('Paused meadow-hr.')).toBeTruthy();
  });

  it('offers Resume while paused, and the message box says it is paused', async () => {
    const api = fakeApi({ resumeSession: async () => action({ kind: 'session.resume', tier: 0, status: 'done', result: 'resumed' }) });
    const { user, ws } = await renderPage(<Both />, { api, overview: kit2() });
    ws.emit({ type: 'activity.updated', items: [activityItem({ paused: true, tool: null })] });
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    const input = screen.getByTestId('session-send-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('Paused. Resume it to send a message.');
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(api.resumeSession).toHaveBeenCalledWith(SID);
    expect(await screen.findByText('Resumed meadow-hr.')).toBeTruthy();
  });

  it('Pause has its own icon, not the one Interrupt uses', async () => {
    await renderPage(<Both />, { overview: kit2() });
    const glyph = (name: string) => screen.getByRole('button', { name }).querySelector('svg')?.innerHTML ?? '';
    expect(glyph('Pause')).not.toBe('');
    expect(glyph('Pause')).not.toBe(glyph('Interrupt'));
  });

  it('on a kit-1 server the button is disabled and says why', async () => {
    await renderPage(<Both />, { overview: overview({ sessions: [session({ state: 'working' })] }) });
    const button = screen.getByRole('button', { name: 'Pause' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Update the kit on cedar to pause.');
  });
});
