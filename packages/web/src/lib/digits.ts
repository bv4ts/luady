/**
 * Arabic-Indic (U+0660–U+0669) and Extended Arabic-Indic (U+06F0–U+06F9) digits become
 * ASCII, and the Arabic comma (U+060C) becomes ",". API schemas stay ASCII-only.
 */
export function normalizeDigits(text: string): string {
  return text
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/\u060c/g, ',');
}

/** What PIN inputs keep: ASCII digits only, after normalization. */
export function pinDigits(text: string): string {
  return normalizeDigits(text).replace(/[^0-9]/g, '');
}

/** PIN-looking text is never sent to Luady. */
export function looksLikePin(text: string): boolean {
  return /^\d{6,12}$/.test(normalizeDigits(text.trim()));
}
