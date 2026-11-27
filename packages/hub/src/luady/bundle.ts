const CONTINUATION = '\n   ';

/** Owner messages that reach Luady together, numbered so none of them gets overlooked; one message passes as is. */
export function bundleMessages(texts: readonly string[]): string {
  if (texts.length === 1) return texts[0] ?? '';
  const items = texts.map((text, index) => `${index + 1}) ${text.replace(/\n/g, CONTINUATION)}`);
  return [`${texts.length} messages, handle every one:`, ...items].join('\n');
}
