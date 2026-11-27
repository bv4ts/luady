import { useMemo } from 'react';
import { renderMarkdown } from './render.js';

/** The only place the SPA injects HTML; the input is always marked (raw HTML escaped) + DOMPurify. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={className ? `prose ${className}` : 'prose'} dir="auto" dangerouslySetInnerHTML={{ __html: html }} />;
}
