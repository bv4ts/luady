import type { SessionDTO } from '@luady/shared';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotePopover } from '../../../../src/features/agency/hud/NotePopover.js';
import { action, activityItem } from '../../../fixtures.js';
import { fakeApi } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { agent, fleetOverview } from '../agency-fixtures.js';

const AT = { id: 'birch:app-backend', x: 40, y: 60 };

async function open(session: SessionDTO = agent('birch', 'app-backend')) {
  const onClose = vi.fn();
  const api = fakeApi({ sendToSession: async () => action({ kind: 'session.send', tier: 0, status: 'done' }) });
  const harness = await renderPage(<NotePopover at={AT} session={session} onClose={onClose} />, {
    api, overview: fleetOverview({ sessions: [session] }),
  });
  return { ...harness, onClose };
}

describe('NotePopover', () => {
  it('sends the note and closes', async () => {
    const { user, api, onClose } = await open();
    expect(document.activeElement).toBe(screen.getByTestId('note-input'));
    await user.type(screen.getByTestId('note-input'), 'Also update the changelog.');
    await user.click(screen.getByTestId('note-send'));
    expect(api.sendToSession).toHaveBeenCalledWith('birch:app-backend', { text: 'Also update the changelog.' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes with Escape and sends with Ctrl+Enter', async () => {
    const { user, api, onClose } = await open();
    await user.type(screen.getByTestId('note-input'), 'run lint');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.sendToSession).not.toHaveBeenCalled();
    await user.type(screen.getByTestId('note-input'), '{Control>}{Enter}{/Control}');
    expect(api.sendToSession).toHaveBeenCalledWith('birch:app-backend', { text: 'run lint' });
  });

  it('is blocked with a one-line hint while the agent is paused', async () => {
    const { ws } = await open();
    ws.emit({ type: 'activity.updated', items: [activityItem({ sessionId: 'birch:app-backend', paused: true, tool: null })] });
    expect(screen.getByText('Paused. Resume it to send a note.')).toBeTruthy();
    expect((screen.getByTestId('note-send') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('note-input') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('is blocked while a question waits for the owner', async () => {
    await open(agent('birch', 'app-backend', { state: 'waiting_question', pendingQid: 'QWAIT001' }));
    expect(screen.getByText('It is waiting for your answer first.')).toBeTruthy();
    expect((screen.getByTestId('note-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('is blocked once the agent has ended', async () => {
    await open(agent('birch', 'app-backend', { state: 'ended' }));
    expect(screen.getByText('This agent has ended.')).toBeTruthy();
    expect((screen.getByTestId('note-send') as HTMLButtonElement).disabled).toBe(true);
  });
});
