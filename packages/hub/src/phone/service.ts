import type { WebSocket } from 'ws';
import type { Clock, LuadyService, Logger, OutboundChannel, PhoneService, QuestionService, SettingsService } from '../core/contracts.js';
import { RefusedError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { soundsLikePin } from '../inbound/parse.js';
import { VOICE_LANGUAGES, forSpeech, languageOf } from './speech.js';
import type { TwilioClient } from './twilio.js';
import { managerName, type CallLanguage } from '@luady/shared';

/** A missed escalation call is retried once after 10 minutes, then the owner gets a chat note. */
export const RETRY_AFTER_MS = 10 * 60_000;
/** Luady thinks for a while; after this the caller hears a short filler instead of silence. */
export const FILLER_AFTER_MS = 3_000;
/** A call nobody speaks on for this long is ended. */
export const IDLE_HANGUP_MS = 3 * 60_000;
const GREETING_MAX = 700;
const HOUR_MS = 60 * 60_000;
const MACHINE = /^(machine|fax)/;
const MISSED = new Set(['no-answer', 'busy', 'failed', 'canceled']);

type Purpose = { kind: 'owner'; reason: string } | { kind: 'question'; qid: string };

interface Call {
  id: string;
  purpose: Purpose;
  attempt: number;
  callSid: string | null;
  connected: boolean;
  machine: boolean;
  socket: WebSocket | null;
  /** The languages this call offers (settings `call_languages` when it was placed): its TwiML declares them. */
  languages: readonly CallLanguage[];
  lang: CallLanguage;
  contextSent: boolean;
  filler: ReturnType<typeof setTimeout> | null;
  idle: ReturnType<typeof setTimeout> | null;
}

export interface TwilioPhoneDeps {
  client: TwilioClient;
  /** https://voice.<domain>: Twilio reaches the hub's voice ingress here. */
  origin: string;
  ownerPhone: string;
  clock: Clock;
  log: Logger;
  settings: SettingsService;
  questions: QuestionService;
  outbound: OutboundChannel;
  /** Late-bound: the Luady service is built after the phone. */
  luady: () => LuadyService;
}

export interface TwilioPhone extends PhoneService {
  greeting(callId: string): string | null;
  relayUrl(callId: string): string;
  /** The languages a call offers, the first one first; English for an unknown call. */
  languages(callId: string): readonly CallLanguage[];
  onStatus(callId: string, params: Readonly<Record<string, string>>): void;
  onAmd(callId: string, params: Readonly<Record<string, string>>): void;
  attach(callId: string, socket: WebSocket): boolean;
  say(text: string): boolean;
  stop(): void;
}

function spokenLabel(label: string): string {
  return label.replace(/\s·\s/g, ' ');
}

export function createTwilioPhone(deps: TwilioPhoneDeps): TwilioPhone {
  const calls = new Map<string, Call>();
  const placedAt: number[] = [];
  const retries = new Set<ReturnType<typeof setTimeout>>();
  let active: Call | null = null;

  const wsOrigin = deps.origin.replace(/^https:/, 'wss:');

  function send(call: Call, message: Record<string, unknown>): void {
    if (call.socket !== null && call.socket.readyState === 1) call.socket.send(JSON.stringify(message));
  }

  function clearTimers(call: Call): void {
    if (call.filler !== null) clearTimeout(call.filler);
    if (call.idle !== null) clearTimeout(call.idle);
    call.filler = null;
    call.idle = null;
  }

  function armIdle(call: Call): void {
    if (call.idle !== null) clearTimeout(call.idle);
    call.idle = setTimeout(() => send(call, { type: 'end' }), IDLE_HANGUP_MS);
  }

  function questionGreeting(qid: string): string {
    const question = deps.questions.get(qid);
    const first = question?.questions[0];
    if (question === undefined || first === undefined) return `Hi, it's ${managerName()}. A session needs your answer.`;
    const options = (first.options ?? []).map((option, index) => `Option ${index + 1}: ${option.label}.`).join(' ');
    return `Hi, it's ${managerName()}. ${spokenLabel(question.sessionLabel)} is waiting for your answer. ${first.question} ${options} What should I tell it?`;
  }

  function context(call: Call): string {
    if (call.purpose.kind === 'owner') return `(Phone call you placed because: ${call.purpose.reason}. You already said "Hi, it's ${managerName()}.")`;
    const question = deps.questions.get(call.purpose.qid);
    return `(Phone call about question #${call.purpose.qid}${question ? ` from ${question.sessionLabel}` : ''}; the greeting read it out. When the owner decides, answer it with question_answer.)`;
  }

  async function place(purpose: Purpose, attempt: number): Promise<void> {
    const now = deps.clock.now().getTime();
    while (placedAt.length > 0 && now - (placedAt[0] ?? 0) > HOUR_MS) placedAt.shift();
    if (placedAt.length >= deps.settings.get().call_rate_per_hour) throw new RefusedError('The hourly call limit is reached; try again later.');
    const id = newId();
    const languages = deps.settings.get().call_languages;
    const call: Call = {
      id, purpose, attempt, callSid: null, connected: false, machine: false, socket: null, languages, lang: languages[0] ?? 'en',
      contextSent: false, filler: null, idle: null,
    };
    calls.set(id, call);
    placedAt.push(now);
    try {
      call.callSid = await deps.client.createCall({
        to: `+${deps.ownerPhone}`,
        twimlUrl: `${deps.origin}/twilio/voice?call=${id}`,
        statusUrl: `${deps.origin}/twilio/status?call=${id}`,
        amdUrl: `${deps.origin}/twilio/amd?call=${id}`,
      });
      deps.log.info({ id, purpose: purpose.kind, attempt }, 'phone: calling the owner');
    } catch (err) {
      calls.delete(id);
      throw err;
    }
  }

  function missed(call: Call): void {
    const purpose = call.purpose;
    if (purpose.kind === 'question' && call.attempt === 1 && deps.questions.get(purpose.qid)?.state === 'pending') {
      const timer = setTimeout(() => {
        retries.delete(timer);
        if (deps.questions.get(purpose.qid)?.state !== 'pending') return;
        place(purpose, 2).catch((err: unknown) => deps.log.warn({ err }, 'phone: retry call failed'));
      }, RETRY_AFTER_MS);
      retries.add(timer);
      return;
    }
    const what = purpose.kind === 'question'
      ? `about #${purpose.qid} (${deps.questions.get(purpose.qid)?.sessionLabel ?? 'a session'}). Reply to the question message to answer it.`
      : `(${purpose.reason}).`;
    deps.outbound.send(`📞 I called but couldn't reach you ${what}`, null).catch(() => null);
  }

  function finish(call: Call): void {
    clearTimers(call);
    calls.delete(call.id);
    if (active === call) active = null;
  }

  async function onPrompt(call: Call, text: string): Promise<void> {
    armIdle(call);
    const words = text.trim();
    if (words === '') return;
    const voice = VOICE_LANGUAGES[call.lang];
    // Whoever is on the line may be talked into saying the PIN: it never reaches the manager or its history.
    if (soundsLikePin(words)) {
      send(call, { type: 'text', token: voice.pinNotice, last: true, lang: voice.code });
      return;
    }
    const prefix = call.contextSent ? '' : `${context(call)}\n`;
    call.contextSent = true;
    if (call.filler !== null) clearTimeout(call.filler);
    call.filler = setTimeout(() => send(call, { type: 'text', token: voice.filler, last: true, lang: voice.code }), FILLER_AFTER_MS);
    await deps.luady().postOwnerMessage(`${prefix}${words}`, 'phone');
  }

  function onRelayMessage(call: Call, raw: string): void {
    let message: { type?: unknown; voicePrompt?: unknown; digit?: unknown; description?: unknown };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    if (message.type === 'setup') {
      call.connected = true;
      active = call;
      armIdle(call);
      deps.log.info({ id: call.id }, 'phone: owner on the line');
    } else if (message.type === 'prompt' && typeof message.voicePrompt === 'string') {
      onPrompt(call, message.voicePrompt).catch((err: unknown) => deps.log.warn({ err }, `phone: could not pass the utterance to ${managerName()}`));
    } else if (message.type === 'dtmf' && typeof message.digit === 'string') {
      onPrompt(call, `(pressed ${message.digit})`).catch(() => undefined);
    } else if (message.type === 'error') {
      deps.log.warn({ id: call.id, description: message.description }, 'phone: relay error');
    }
  }

  return {
    enabled: () => true,
    callOwner: (reason) => place({ kind: 'owner', reason }, 1),
    callForQuestion: (qid) => place({ kind: 'question', qid }, 1),
    greeting(callId) {
      const call = calls.get(callId);
      if (call === undefined) return null;
      const text = call.purpose.kind === 'question' ? questionGreeting(call.purpose.qid) : `Hi, it's ${managerName()}.`;
      return forSpeech(text).slice(0, GREETING_MAX);
    },
    relayUrl: (callId) => `${wsOrigin}/twilio/relay?call=${callId}`,
    languages: (callId) => calls.get(callId)?.languages ?? ['en'],
    onStatus(callId, params) {
      const call = calls.get(callId);
      if (call === undefined) return;
      const status = params.CallStatus ?? '';
      if (status !== 'completed' && !MISSED.has(status)) return;
      const wasMissed = !call.connected || call.machine;
      finish(call);
      if (wasMissed) missed(call);
      deps.log.info({ id: callId, status, missed: wasMissed }, 'phone: call over');
    },
    onAmd(callId, params) {
      const call = calls.get(callId);
      if (call === undefined || !MACHINE.test(params.AnsweredBy ?? '')) return;
      call.machine = true;
      if (call.callSid !== null) deps.client.hangUp(call.callSid).catch((err: unknown) => deps.log.warn({ err }, 'phone: hang-up failed'));
    },
    attach(callId, socket) {
      const call = calls.get(callId);
      if (call === undefined) return false;
      call.socket = socket;
      socket.on('message', (data) => onRelayMessage(call, data.toString()));
      socket.on('close', () => {
        clearTimers(call);
        if (active === call) active = null;
      });
      return true;
    },
    say(text) {
      const call = active;
      if (call === null || call.socket === null || call.socket.readyState !== 1) return false;
      if (call.filler !== null) clearTimeout(call.filler);
      call.filler = null;
      const lang = languageOf(text, call.languages);
      const code = VOICE_LANGUAGES[lang].code;
      if (lang !== call.lang) {
        call.lang = lang;
        send(call, { type: 'language', ttsLanguage: code, transcriptionLanguage: code });
      }
      send(call, { type: 'text', token: forSpeech(text), last: true, lang: code });
      armIdle(call);
      return true;
    },
    stop() {
      for (const timer of retries) clearTimeout(timer);
      retries.clear();
      for (const call of calls.values()) clearTimers(call);
    },
  };
}
