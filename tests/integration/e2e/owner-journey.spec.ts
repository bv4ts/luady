import { QUESTION_TEXT, waitForLog } from '../harness/scenario.js';
import { waitFor } from '../harness/wait.js';
import { expect, test } from './fixtures.js';
import { finishWizard } from './owner.js';

const PIN = '246813';
const MESSAGE = 'مرحبا من المتصفح 👋 — "quotes" and $(whoami)\nsecond line';

test('owner journey: setup code → passkey → PIN → login → answer → send → confirm a tier-1 action with the PIN', async ({ page, e2e }) => {
  const { hub, server } = e2e;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    },
  });

  await test.step('first visit: setup code and passkey registration', async () => {
    await page.goto(e2e.baseURL);
    await page.getByTestId('setup-code-input').fill(hub.app.services.setupCodes.issue('owner_setup'));
    await page.getByTestId('setup-passkey-button').click();
    await expect(page.getByTestId('pin-new-input')).toBeVisible();
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    expect(credentials).toHaveLength(1);
  });

  await test.step('set the PIN', async () => {
    await page.getByTestId('pin-new-input').fill(PIN);
    await page.getByTestId('pin-confirm-input').fill(PIN);
    await page.getByTestId('pin-save-button').click();
    // The rest of the wizard, skipped; `/` is the office then (without WebGL the classic Inbox, which has the nav).
    await finishWizard(page);
    expect(hub.app.services.pin.isSet()).toBe(true);
    await page.goto(new URL('/inbox', e2e.baseURL).toString());
    await expect(page.getByTestId('nav-inbox')).toBeVisible();
  });

  await test.step('log out and log back in with the passkey', async () => {
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('logout-button').click();
    await expect(page.getByTestId('login-passkey-button')).toBeVisible();
    await page.getByTestId('login-passkey-button').click();
    await expect(page.getByTestId('nav-inbox')).toBeVisible();
  });

  await test.step('answer a pending question from the Inbox', async () => {
    await page.getByTestId('nav-inbox').click();
    await server.typeInto(e2e.target, '/ask');
    const question = await waitFor(() => hub.app.services.questions.pending().find((q) => q.sessionId === e2e.sessionId), { what: 'pending question' });
    const card = page.locator(`[data-testid="question-card"][data-qid="${question.qid}"]`);
    await expect(card).toBeVisible();
    await card.getByTestId('question-option').filter({ hasText: 'Blue' }).click();
    await card.getByTestId('question-submit').click();
    const entry = await waitForLog(server, (e) => e.kind === 'answers' && e.sid === e2e.sid, 'answer delivered to fake-claude');
    expect(entry.answers).toEqual({ [QUESTION_TEXT]: 'Blue' });
  });

  await test.step('send a session message from the session view', async () => {
    await page.getByTestId('nav-sessions').click();
    await page.locator(`[data-testid="session-link"][data-session-id="${e2e.sessionId}"]`).click();
    await page.getByTestId('session-send-input').fill(MESSAGE);
    await page.getByTestId('session-send-button').click();
    const entry = await waitForLog(server, (e) => e.kind === 'received' && e.sid === e2e.sid && e.text === MESSAGE, 'message typed into the session');
    expect(entry.text).toBe(MESSAGE);
  });

  await test.step('confirm a tier-1 action requested by Luady with the PIN', async () => {
    const res = await hub.app.internal.inject({
      method: 'POST',
      url: '/internal/tools/session_stop',
      headers: { authorization: `Bearer ${hub.config.hubSocketToken}` },
      payload: { session: e2e.sessionId, reason: 'e2e: Luady asks to stop the test session' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    const action = hub.app.services.actions.pending().find((a) => a.kind === 'session.stop');
    expect(action?.status).toBe('pending_confirmation');
    await page.getByTestId('nav-inbox').click();
    const card = page.locator(`[data-testid="action-card"][data-action-id="${action?.id}"]`);
    await expect(card).toBeVisible();
    await card.getByTestId('action-pin-input').fill(PIN);
    await card.getByTestId('action-approve-button').click();
    await expect.poll(() => hub.app.services.actions.get(action?.id ?? '')?.status, { timeout: 60_000 }).toBe('done');
    await waitForLog(server, (e) => e.kind === 'exit' && e.sid === e2e.sid, 'fake-claude exited');
  });
});
