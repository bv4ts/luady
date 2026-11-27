import { ValidationError } from '../core/errors.js';
import { managerName } from '@luady/shared';

export const PIN_LIKE_MESSAGE =
  `That looks like a PIN. Never send your PIN to ${managerName()}; reply to the confirmation message instead.`;

const PIN_LIKE_RE = /^\d{6,12}$/;
/** U+0660 ARABIC-INDIC DIGIT ZERO and U+06F0 EXTENDED ARABIC-INDIC DIGIT ZERO; each range holds 10 digits. */
const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

function asciiDigit(char: string): string {
  const code = char.charCodeAt(0);
  if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) return String(code - ARABIC_INDIC_ZERO);
  if (code >= EXTENDED_ARABIC_INDIC_ZERO && code <= EXTENDED_ARABIC_INDIC_ZERO + 9) {
    return String(code - EXTENDED_ARABIC_INDIC_ZERO);
  }
  return char;
}

/** Arabic-Indic (U+0660–U+0669) and Extended Arabic-Indic (U+06F0–U+06F9) digits become ASCII 0–9. */
export function normalizeDigits(text: string): string {
  return Array.from(text, asciiDigit).join('');
}

/** True when the whole message, after digit normalization and trimming, is 6–12 ASCII digits. */
export function looksLikePin(text: string): boolean {
  return PIN_LIKE_RE.test(normalizeDigits(text).trim());
}

/** A PIN never enters Luady's context; the owner approves by replying to the confirmation instead. */
export function assertNotPinLike(text: string): void {
  if (looksLikePin(text)) throw new ValidationError(PIN_LIKE_MESSAGE);
}
