/**
 * React Router already decodes params; this also accepts a double-encoded id. Session ids never
 * contain '%', so a malformed escape is returned unchanged (the lookup then reports "not found").
 */
export function decodeParam(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
