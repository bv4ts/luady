import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type QuestionDTO, type Settings } from '@luady/shared';
import type { LuadyService, QuestionService } from '../../src/core/contracts.js';
import { createVoiceServer } from '../../src/phone/server.js';
import { RETRY_AFTER_MS, createTwilioPhone } from '../../src/phone/service.js';
import { VOICE_LANGUAGES, forSpeech, languageOf, relayTwiml } from '../../src/phone/speech.js';
import { twilioSignature, validTwilioSignature, type TwilioClient } from '../../src/phone/twilio.js';
import { createFakeClock, createFakeOutbound, silentLogger } from '../helpers/fakes.js';

const TOKEN = ['01234567', '89abcdef', '01234567', '89abcdef'].join('');
const ORIGIN = 'https://voice.example.com';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

const QUESTION = {
  qid: 'Q7ABCDEF', kind: 'question', host: 'cedar', sessionId: 'cedar:cc-meadow-hr:0.0', sessionLabel: 'cedar · meadow-hr',
  questions: [{ question: 'Deploy to staging now?', header: 'Deploy', options: [{ label: 'Yes' }, { label: 'Not yet' }], multiSelect: false }],
  permission: null, state: 'pending', createdAt: '2026-10-10T10:00:00Z', resolvedAt: null, resolvedVia: null,
} as unknown as QuestionDTO;

function setup(languages: Settings['call_languages'] = DEFAULT_SETTINGS.call_languages) {
  const client: TwilioClient & { calls: unknown[] } = {
    calls: [],
    createCall: vi.fn(async (args) => {
      client.calls.push(args);
      return `CA${client.calls.length}`;
    }),
    hangUp: vi.fn(async () => undefined),
  };
  const outbound = createFakeOutbound();
  const postOwnerMessage = vi.fn(async () => undefined);
  let question: QuestionDTO | undefined = QUESTION;
  const phone = createTwilioPhone({
    client, origin: ORIGIN, ownerPhone: '447700900001', clock: createFakeClock(), log: silentLogger(),
    settings: { get: () => ({ ...DEFAULT_SETTINGS, call_languages: languages }), update: vi.fn() },
    questions: { get: () => question } as unknown as QuestionService,
    outbound,
    luady: () => ({ postOwnerMessage }) as unknown as LuadyService,
  });
  const callId = (): string => new URL((client.calls.at(-1) as { twimlUrl: string }).twimlUrl).searchParams.get('call') ?? '';
  return { client, outbound, postOwnerMessage, phone, callId, resolve: () => { question = { ...QUESTION, state: 'answered' } as QuestionDTO; } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('twilio signature', () => {
  it('signs url + sorted params and rejects tampering', () => {
    const params = { To: '+447700900001', CallStatus: 'completed' };
    const sig = twilioSignature(TOKEN, `${ORIGIN}/twilio/status?call=abc12345`, params);
    expect(validTwilioSignature(TOKEN, sig, `${ORIGIN}/twilio/status?call=abc12345`, params)).toBe(true);
    expect(validTwilioSignature(TOKEN, sig, `${ORIGIN}/twilio/status?call=abc12345`, { ...params, CallStatus: 'busy' })).toBe(false);
    expect(validTwilioSignature(TOKEN, undefined, `${ORIGIN}/x`)).toBe(false);
  });
});

describe('speech helpers', () => {
  it('turn the chat text into something a voice can read, and spot the language of an offered script', () => {
    expect(forSpeech('✅ *Done* · see `npm test` at https://x.com/a')).toBe('Done see npm test at the link');
    expect(languageOf('تم إصلاح المشكلة', ['en', 'ar'])).toBe('ar');
    expect(languageOf('Fixed it, PR #643', ['en', 'ar'])).toBe('en');
    // A language the call does not offer is never chosen: the call stays in its first language.
    expect(languageOf('تم إصلاح المشكلة', ['en'])).toBe('en');
    const xml = relayTwiml({ relayUrl: 'wss://v/twilio/relay?call=a&b', greeting: 'Hi "you" <3', languages: ['en', 'ar'] });
    expect(xml).toContain('url="wss://v/twilio/relay?call=a&amp;b"');
    expect(xml).toContain('welcomeGreeting="Hi &quot;you&quot; &lt;3"');
    expect(xml).toContain('language="en-US" ttsProvider="ElevenLabs" transcriptionProvider="Deepgram" speechModel="nova-3-general"');
    expect(xml).toContain('<Language code="ar-AE" ttsProvider="Amazon" voice="Zayd-Neural" transcriptionProvider="Deepgram" speechModel="nova-3-general"/>');
    expect(xml).not.toContain('hints=');
  });

  it('a call offers English only by default; each language comes from the small voice table', () => {
    expect(DEFAULT_SETTINGS.call_languages).toEqual(['en']);
    const xml = relayTwiml({ relayUrl: 'wss://v/r', greeting: 'Hi', languages: DEFAULT_SETTINGS.call_languages });
    expect(xml).toContain('language="en-US"');
    expect(xml).not.toContain('<Language ');
    expect(Object.keys(VOICE_LANGUAGES)).toEqual(['en', 'ar', 'de', 'fr', 'pt']);
  });

  it('every voice language names one region code for both directions, transcribed by Deepgram nova-3-general', () => {
    for (const lang of Object.values(VOICE_LANGUAGES)) {
      expect(lang.code).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
      expect([lang.transcriptionProvider, lang.speechModel]).toEqual(['Deepgram', 'nova-3-general']);
      expect(lang.filler.length).toBeGreaterThan(0);
      expect(lang.pinNotice.length).toBeGreaterThan(0);
    }
    expect(Object.values(VOICE_LANGUAGES).map((lang) => lang.code)).toEqual(['en-US', 'ar-AE', 'de-DE', 'fr-CA', 'pt-BR']);
  });

  it('a call in German declares German first, with the provider\'s own voice, and English as the second language', () => {
    const xml = relayTwiml({ relayUrl: 'wss://v/r', greeting: 'Hallo', languages: ['de', 'en'] });
    expect(xml).toContain('language="de-DE" ttsProvider="ElevenLabs" transcriptionProvider="Deepgram" speechModel="nova-3-general"');
    expect(xml).toContain('<Language code="en-US" ttsProvider="ElevenLabs" transcriptionProvider="Deepgram" speechModel="nova-3-general"/>');
    expect(xml).not.toContain('voice=');
  });

  it('languages in the same script are not told apart: such a call speaks its first language', () => {
    expect(languageOf('Fixed it, PR #643', ['de', 'en'])).toBe('de');
    expect(languageOf('Erledigt, alles fertig.', ['en', 'de'])).toBe('en');
    expect(languageOf('تم إصلاح المشكلة', ['pt', 'ar'])).toBe('ar');
  });
});

describe('twilio phone', () => {
  it('an English-only call (the default) stays in English when the manager answers in another script', async () => {
    const t = setup();
    await t.phone.callForQuestion('Q7ABCDEF');
    expect(t.phone.languages(t.callId())).toEqual(['en']);
    const socket = new FakeSocket();
    t.phone.attach(t.callId(), socket as never);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'setup', callSid: 'CA1' })));
    expect(t.phone.say('حسناً')).toBe(true);
    expect(socket.sent.filter((m) => (m as { type?: string }).type === 'language')).toEqual([]);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'text', lang: 'en-US' });
    socket.close();
  });

  it('reads the question in the greeting, passes the owner\'s words to Luady with context, and speaks the reply', async () => {
    // The second language is chosen in settings: then the call switches when Luady answers in it.
    const t = setup(['en', 'ar']);
    await t.phone.callForQuestion('Q7ABCDEF');
    expect(t.phone.languages(t.callId())).toEqual(['en', 'ar']);
    expect(t.client.calls[0]).toMatchObject({ to: '+447700900001', twimlUrl: expect.stringContaining(`${ORIGIN}/twilio/voice?call=`) });
    expect(t.phone.greeting(t.callId())).toBe("Hi, it's Luady. cedar meadow-hr is waiting for your answer. Deploy to staging now? Option 1: Yes. Option 2: Not yet. What should I tell it?");
    const socket = new FakeSocket();
    expect(t.phone.attach(t.callId(), socket as never)).toBe(true);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'setup', callSid: 'CA1' })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'prompt', voicePrompt: 'Say not yet', last: true })));
    await vi.waitFor(() => expect(t.postOwnerMessage).toHaveBeenCalled());
    expect(t.postOwnerMessage.mock.calls[0]).toEqual([expect.stringMatching(/^\(Phone call about question #Q7ABCDEF from cedar · meadow-hr.*\)\nSay not yet$/s), 'phone']);
    expect(t.phone.say('حسناً، أخبرته ألا ينشر الآن.')).toBe(true);
    expect(socket.sent.slice(-2)).toEqual([
      { type: 'language', ttsLanguage: 'ar-AE', transcriptionLanguage: 'ar-AE' },
      { type: 'text', token: 'حسناً، أخبرته ألا ينشر الآن.', last: true, lang: 'ar-AE' },
    ]);
    socket.close();
    expect(t.phone.say('anyone?')).toBe(false);
    t.phone.stop();
  });

  it('never passes words that sound like a PIN to the manager, and says so on the call', async () => {
    const t = setup();
    await t.phone.callForQuestion('Q7ABCDEF');
    const socket = new FakeSocket();
    t.phone.attach(t.callId(), socket as never);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'setup', callSid: 'CA1' })));
    for (const said of ['482913', '4 8 2 9 1 3.', '482-913']) {
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'prompt', voicePrompt: said, last: true })));
    }
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'prompt', voicePrompt: 'Say not yet', last: true })));
    await vi.waitFor(() => expect(t.postOwnerMessage).toHaveBeenCalledTimes(1));
    expect(t.postOwnerMessage.mock.calls[0]?.[0]).toMatch(/\nSay not yet$/);
    const notices = socket.sent.filter((m) => (m as { token?: string }).token === VOICE_LANGUAGES.en.pinNotice);
    expect(notices).toHaveLength(3);
    socket.close();
    t.phone.stop();
  });

  it('retries a missed escalation once after 10 minutes, then sends a chat note', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.phone.callForQuestion('Q7ABCDEF');
    t.phone.onStatus(t.callId(), { CallStatus: 'no-answer' });
    expect(t.client.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    expect(t.client.calls).toHaveLength(2);
    t.phone.onAmd(t.callId(), { AnsweredBy: 'machine_start' });
    expect(t.client.hangUp).toHaveBeenCalledWith('CA2');
    t.phone.onStatus(t.callId(), { CallStatus: 'completed' });
    expect(t.outbound.sent.at(-1)?.text).toContain("📞 I called but couldn't reach you about #Q7ABCDEF");
    t.phone.stop();
  });

  it('does not retry when the question was answered meanwhile, and respects the hourly limit', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.phone.callForQuestion('Q7ABCDEF');
    t.phone.onStatus(t.callId(), { CallStatus: 'busy' });
    t.resolve();
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    expect(t.client.calls).toHaveLength(1);
    await t.phone.callOwner('test');
    await t.phone.callOwner('test');
    await expect(t.phone.callOwner('test')).rejects.toThrow(/hourly call limit/);
    t.phone.stop();
  });
});

describe('voice ingress', () => {
  it('answers a signed voice webhook with ConversationRelay TwiML and rejects unsigned ones', async () => {
    const t = setup();
    await t.phone.callOwner('owner asked');
    const app = await createVoiceServer({ phone: t.phone, authToken: TOKEN, origin: ORIGIN, log: silentLogger() });
    const path = `/twilio/voice?call=${t.callId()}`;
    const form = { CallSid: 'CA1', CallStatus: 'in-progress' };
    const signature = twilioSignature(TOKEN, `${ORIGIN}${path}`, form);
    const ok = await app.inject({
      method: 'POST', url: path, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
      payload: new URLSearchParams(form).toString(),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('<ConversationRelay url="wss://voice.example.com/twilio/relay?call=');
    expect(ok.body).toContain('welcomeGreeting="Hi, it&apos;s Luady."');
    const forged = await app.inject({
      method: 'POST', url: path, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'nope' },
      payload: new URLSearchParams(form).toString(),
    });
    expect(forged.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    await app.close();
    t.phone.stop();
  });
});
