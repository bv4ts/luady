/**
 * Calls `onChange(false)` when the tab is hidden or `host` scrolls off screen, and `onChange(true)` when both are
 * fine again. Only real changes are reported. Returns a function that stops watching.
 */
export function watchVisibility(host: HTMLElement, onChange: (visible: boolean) => void): () => void {
  let onScreen = true;
  let visible = !document.hidden;

  const report = (): void => {
    const next = onScreen && !document.hidden;
    if (next === visible) return;
    visible = next;
    onChange(next);
  };

  document.addEventListener('visibilitychange', report);
  const observer = typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver((entries) => {
      const last = entries.at(-1);
      if (last === undefined) return;
      onScreen = last.isIntersecting;
      report();
    });
  observer?.observe(host);
  if (!visible) onChange(false);

  return () => {
    document.removeEventListener('visibilitychange', report);
    observer?.disconnect();
  };
}
