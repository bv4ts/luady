import type { CallLanguage } from '@luady/shared';

/** Text-to-speech hygiene: the manager writes for the chat; a phone voice must not read markdown, links or emoji. */
export function forSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/[*_~#>]+/g, '')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/\s·\s/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One language a call can speak and listen in: its Twilio ConversationRelay settings and its words. */
export interface VoiceLanguage {
  readonly code: string;
  readonly ttsProvider: string;
  /** Null: the provider's own default voice for the language. */
  readonly voice: string | null;
  readonly transcriptionProvider: string;
  readonly speechModel: string;
  /** The script a text is mostly written in when it is in this language; null for the Latin-script fallback. */
  readonly script: RegExp | null;
  /** What the caller hears while the manager thinks. */
  readonly filler: string;
  /** What the caller hears when their words sounded like a PIN, which never reaches the manager. */
  readonly pinNotice: string;
}

/** A language spoken by the provider's own default voice for its code, and transcribed by Deepgram's Nova-3. */
function defaultVoice(code: string, filler: string, pinNotice: string): VoiceLanguage {
  return { code, ttsProvider: 'ElevenLabs', voice: null, transcriptionProvider: 'Deepgram', speechModel: 'nova-3-general', script: null, filler, pinNotice };
}

/**
 * The voice languages (settings `call_languages` picks which a call offers; English only by default). An invalid voice
 * or model rejects the whole call (Twilio 64101), so each code is one that both sides document: Twilio's
 * ConversationRelay has a default ElevenLabs voice for it, and Deepgram's Nova-3 transcribes it.
 * Languages in the same script are not told apart (`languageOf`): such a call speaks its first language.
 */
export const VOICE_LANGUAGES: Readonly<Record<CallLanguage, VoiceLanguage>> = Object.freeze({
  en: defaultVoice('en-US', 'One moment.', 'That sounded like a PIN, so I did not pass it on. Your PIN only approves a confirmation.'),
  ar: {
    code: 'ar-AE', ttsProvider: 'Amazon', voice: 'Zayd-Neural', transcriptionProvider: 'Deepgram', speechModel: 'nova-3-general',
    script: /\p{Script=Arabic}/u, filler: 'لحظة من فضلك.',
    pinNotice: 'يبدو أن هذا رقم سري، لذلك لم أنقله. رقمك السري للموافقة على التأكيدات فقط.',
  },
  de: defaultVoice('de-DE', 'Einen Moment, bitte.', 'Das klang wie eine PIN, deshalb habe ich es nicht weitergegeben. Ihre PIN bestätigt nur Freigaben.'),
  fr: defaultVoice('fr-CA', 'Un instant, s’il vous plaît.', 'Cela ressemblait à un NIP, alors je ne l’ai pas transmis. Votre NIP sert seulement à confirmer.'),
  pt: defaultVoice('pt-BR', 'Um momento, por favor.', 'Isso pareceu um PIN, então não repassei. Seu PIN serve só para aprovar confirmações.'),
});

/** The share of a text's letters in a script (0 for a text without letters). */
function scriptShare(text: string, script: RegExp): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  return letters.length === 0 ? 0 : letters.filter((ch) => script.test(ch)).length / letters.length;
}

/** The offered language a text is in: the one whose script holds most of its letters, else the call's first language. */
export function languageOf(text: string, offered: readonly CallLanguage[]): CallLanguage {
  const first = offered[0] ?? 'en';
  return offered.find((id) => {
    const script = VOICE_LANGUAGES[id].script;
    return script !== null && scriptShare(text, script) > 0.5;
  }) ?? first;
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface RelayOptions {
  relayUrl: string;
  greeting: string;
  /** The languages the call offers, the first one first (settings `call_languages`). */
  languages: readonly CallLanguage[];
}

const voiceAttrs = (lang: VoiceLanguage): string[] => [
  `ttsProvider="${escapeXml(lang.ttsProvider)}"`,
  ...(lang.voice === null ? [] : [`voice="${escapeXml(lang.voice)}"`]),
  `transcriptionProvider="${escapeXml(lang.transcriptionProvider)}"`,
  `speechModel="${escapeXml(lang.speechModel)}"`,
];

/** TwiML for an answered call: hand the audio to ConversationRelay (Twilio does STT/TTS, the hub does the talking). */
export function relayTwiml(opts: RelayOptions): string {
  const [first = 'en', ...others] = opts.languages;
  const main = VOICE_LANGUAGES[first];
  const attrs = [
    `url="${escapeXml(opts.relayUrl)}"`,
    `welcomeGreeting="${escapeXml(opts.greeting)}"`,
    `language="${escapeXml(main.code)}"`,
    ...voiceAttrs(main),
    'interruptible="any"',
    'dtmfDetection="true"',
  ].join(' ');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response><Connect>',
    // A language must be declared here before a `language` message can switch to it (Twilio 64106).
    `<ConversationRelay ${attrs}>`,
    ...others.map((id) => `<Language code="${escapeXml(VOICE_LANGUAGES[id].code)}" ${voiceAttrs(VOICE_LANGUAGES[id]).join(' ')}/>`),
    '</ConversationRelay>',
    '</Connect></Response>',
  ].join('');
}

export const HANGUP_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
