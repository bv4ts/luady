/** The single place for client-side diagnostics. User-facing errors go through toasts or inline messages. */
export function reportError(context: string, err: unknown): void {
  console.warn(`[luady] ${context}:`, err);
}
