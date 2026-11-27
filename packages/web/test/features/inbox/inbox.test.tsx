import type { AskQuestion } from '@luady/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/api/errors.js';
import { InboxPage } from '../../../src/features/inbox/InboxPage.js';
import { action, overview, permission, question, server } from '../../fixtures.js';
import { fakeApi } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';

const multi: AskQuestion[] = [
  { question: 'Which database?', header: 'Database', multiSelect: false, options: [{ label: 'Postgres', description: 'Relational, already in use' }, { label: 'SQLite', description: 'Single file' }] },
  { question: 'Which checks should run?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Tests' }, { label: 'Build' }] },
];

describe('InboxPage', () => {
  it('answers a multi-question card with the exact body', async () => {
    const api = fakeApi({ answerQuestion: async () => question({ state: 'answered' }) });
    const { user } = await renderPage(<InboxPage />, { api, overview: overview({ questions: [question({ questions: multi })], actions: [] }) });
    await user.click(screen.getByRole('radio', { name: /SQLite/ }));
    await user.click(screen.getByRole('checkbox', { name: /Tests/ }));
    await user.click(screen.getByRole('checkbox', { name: /Lint/ }));
    await user.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(api.answerQuestion).toHaveBeenCalledWith('ABCDEFGH', {
      answers: { 'Which database?': 'SQLite', 'Which checks should run?': 'Lint, Tests' },
    });
    expect(await screen.findByText('Answer sent to cedar · meadow-hr')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull();
  });

  it('sends free text through "Other"', async () => {
    const api = fakeApi({ answerQuestion: async () => question({ state: 'answered' }) });
    const { user } = await renderPage(<InboxPage />, { api, overview: overview({ actions: [] }) });
    await user.click(screen.getByRole('radio', { name: /Other/ }));
    await user.type(screen.getByLabelText('Your answer'), 'MariaDB 11');
    await user.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(api.answerQuestion).toHaveBeenCalledWith('ABCDEFGH', { answers: { 'Which database?': 'MariaDB 11' } });
  });

  it('409 question_closed shows a notice, refreshes and removes the card', async () => {
    const api = fakeApi({ answerQuestion: async () => { throw new ApiError(409, 'question_closed', 'Question #ABCDEFGH is already answered'); } });
    const { user } = await renderPage(<InboxPage />, { api, overview: overview({ actions: [] }) });
    api.overview.mockResolvedValue(overview({ questions: [], actions: [] }));
    await user.click(screen.getByRole('radio', { name: /Postgres/ }));
    await user.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(await screen.findByText('#ABCDEFGH was already resolved — your answer was not sent.')).toBeTruthy();
    await waitFor(() => expect(api.overview).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Which database?')).toBeNull();
    expect(api.answerQuestion).toHaveBeenCalledTimes(1);
  });

  it('validates before calling the hub', async () => {
    const api = fakeApi();
    const { user } = await renderPage(<InboxPage />, { api, overview: overview({ actions: [] }) });
    await user.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(screen.getByText('Pick an option.')).toBeTruthy();
    expect(api.answerQuestion).not.toHaveBeenCalled();
  });

  it('denies a permission request with a message', async () => {
    const api = fakeApi({ answerQuestion: async () => permission({ state: 'answered' }) });
    const { user } = await renderPage(<InboxPage />, { api, overview: overview({ questions: [permission()], actions: [] }) });
    expect(screen.getByText('rm -rf build/')).toBeTruthy();
    await user.type(screen.getByLabelText('Message to Claude (optional)'), ' Use the staging database ');
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    expect(api.answerQuestion).toHaveBeenCalledWith('Q2W3E4R5', { behavior: 'deny', message: 'Use the staging database' });
  });

  it('hands a question back to the terminal', async () => {
    const api = fakeApi({ releaseQuestion: async () => question({ state: 'released' }) });
    const { user } = await renderPage(<InboxPage />, { api, overview: overview({ actions: [] }) });
    await user.click(screen.getByRole('button', { name: 'Answer in terminal' }));
    expect(api.releaseQuestion).toHaveBeenCalledWith('ABCDEFGH');
    expect(await screen.findByText('#ABCDEFGH handed back to the terminal')).toBeTruthy();
  });

  it('marks question cards and options with the e2e test ids', async () => {
    const api = fakeApi({ answerQuestion: async () => question({ state: 'answered' }) });
    const { user } = await renderPage(<InboxPage />, { api, overview: overview({ actions: [] }) });
    const card = screen.getByTestId('question-card');
    expect(card.getAttribute('data-qid')).toBe('ABCDEFGH');
    const options = within(card).getAllByTestId('question-option');
    expect(options.map((option) => option.textContent)).toEqual(['Postgres', 'SQLite']);
    await user.click(options[1] as HTMLElement);
    await user.click(within(card).getByTestId('question-submit'));
    expect(api.answerQuestion).toHaveBeenCalledWith('ABCDEFGH', { answers: { 'Which database?': 'SQLite' } });
  });

  it('approves a confirmation with the PIN typed on the card', async () => {
    const api = fakeApi({ confirmAction: async () => action({ status: 'done', result: 'stopped cc-meadow-hr' }) });
    const { user } = await renderPage(<InboxPage />, { api, overview: overview({ questions: [] }) });
    const card = screen.getByTestId('action-card');
    expect(card.getAttribute('data-action-id')).toBe('A7');
    expect(within(card).getByText('Stop cedar · meadow-hr')).toBeTruthy();
    const input = within(card).getByTestId('action-pin-input');
    expect(input).toBe(within(card).getByLabelText('PIN for #A7'));
    expect([input.getAttribute('autocomplete'), input.getAttribute('inputmode')]).toEqual(['one-time-code', 'numeric']);
    await user.type(input, '123456');
    await user.click(within(card).getByTestId('action-approve-button'));
    await waitFor(() => expect(api.confirmAction).toHaveBeenCalledWith('A7', { pin: '123456' }));
    expect(await screen.findByText('#A7 done: stopped cc-meadow-hr')).toBeTruthy();
    expect(screen.queryByTestId('action-card')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('checks the PIN on the card and shows hub PIN errors there', async () => {
    const api = fakeApi({ confirmAction: async () => { throw new ApiError(403, 'pin_invalid', 'Wrong PIN', { remaining: 2 }); } });
    const { user } = await renderPage(<InboxPage />, { api, overview: overview({ questions: [] }) });
    const card = screen.getByTestId('action-card');
    const input = within(card).getByTestId('action-pin-input') as HTMLInputElement;
    await user.type(input, '12');
    await user.click(within(card).getByTestId('action-approve-button'));
    expect(within(card).getByRole('alert').textContent).toBe('Enter your 6–12 digit PIN.');
    expect(api.confirmAction).not.toHaveBeenCalled();
    await user.type(input, '3456');
    await user.click(within(card).getByTestId('action-approve-button'));
    await waitFor(() => expect(within(card).getByRole('alert').textContent).toBe('Wrong PIN — 2 tries left.'));
    expect(api.confirmAction).toHaveBeenCalledWith('A7', { pin: '123456' });
    await waitFor(() => expect(input.value).toBe(''));
    expect(screen.getByTestId('action-card')).toBeTruthy();
  });

  it('opens the whole text of a message the manager wants to send, and hides it again', async () => {
    const send = action({ kind: 'session.send', summary: 'send to cedar · meadow-hr (40 characters, 2 lines, sha256 0123456789ab)\n| tidy up' });
    const api = fakeApi({ actionText: async () => ({ text: 'tidy up\nthen read the notes<U+202E>' }) });
    const { user } = await renderPage(<InboxPage />, { api, overview: overview({ questions: [], actions: [send] }) });
    const card = screen.getByTestId('action-card');
    await user.click(within(card).getByTestId('action-full-text-button'));
    expect(api.actionText).toHaveBeenCalledWith('A7');
    expect((await within(card).findByTestId('action-full-text')).textContent).toBe('tidy up\nthen read the notes<U+202E>');
    await user.click(within(card).getByRole('button', { name: 'Hide the full text' }));
    expect(within(card).queryByTestId('action-full-text')).toBeNull();
  });

  it('shows no full-text button for an action that types or writes nothing', async () => {
    await renderPage(<InboxPage />, { overview: overview({ questions: [] }) });
    expect(within(screen.getByTestId('action-card')).queryByTestId('action-full-text-button')).toBeNull();
  });

  it('denies a confirmation', async () => {
    const api = fakeApi({ denyAction: async () => action({ status: 'denied' }) });
    const { user } = await renderPage(<InboxPage />, { api, overview: overview({ questions: [] }) });
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    expect(api.denyAction).toHaveBeenCalledWith('A7');
    expect(await screen.findByText('Cancelled #A7')).toBeTruthy();
  });

  it('shows server health and flags low disk space', async () => {
    const ash = server({
      name: 'ash', host: '192.0.2.11',
      sysinfo: { load1: 1.2, load5: 1, mem_total_kb: 8_000_000, mem_avail_kb: 1_000_000, disk_free_kb: 5_976_883, uptime_s: 1000 },
    });
    await renderPage(<InboxPage />, { overview: overview({ questions: [], actions: [], servers: [server(), ash] }) });
    const strip = screen.getByRole('list', { name: 'Server health' });
    expect(within(strip).getByText('ash')).toBeTruthy();
    expect(within(strip).getByText('low disk')).toBeTruthy();
  });

  it('shows an empty state when nothing needs the owner', async () => {
    await renderPage(<InboxPage />, { overview: overview({ questions: [], actions: [] }) });
    expect(screen.getByText('All clear')).toBeTruthy();
  });

  it('adds questions that arrive live', async () => {
    const { ws } = await renderPage(<InboxPage />, { overview: overview({ questions: [], actions: [] }) });
    ws.emit({ type: 'question.updated', question: question({ qid: 'NEWQ2345' }) });
    expect(screen.getByText('Which database?')).toBeTruthy();
  });
});
