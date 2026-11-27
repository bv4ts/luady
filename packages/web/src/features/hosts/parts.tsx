import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';

/** One step of a flow: its title, one plain sentence of what will happen, its body and its buttons. */
export function StepFrame({ title, intro, children, actions, testId }: {
  title: string; intro: string; children?: ReactNode; actions?: ReactNode; testId: string;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section className="host-step stack" aria-labelledby={id} data-testid={testId}>
      <h3 className="host-step__title" id={id} ref={heading} tabIndex={-1}>{title}</h3>
      <p className="host-step__intro">{intro}</p>
      {children}
      {actions ? <div className="host-step__actions">{actions}</div> : null}
    </section>
  );
}

/** Text the owner copies into a terminal: shown as it is, selectable, with a copy button that says when it worked. */
export function CopyBlock({ label, text, testId }: { label: string; text: string; testId: string }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const id = useId();
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('yes');
    } catch {
      setCopied('no');
    }
  }
  return (
    <div className="host-copy">
      <p className="field__label" id={id}>{label}</p>
      <pre className="host-copy__text mono" aria-labelledby={id} data-testid={testId} tabIndex={0}>{text}</pre>
      <div className="row">
        <Button size="sm" icon="file" onClick={() => void copy()}>Copy</Button>
        <span className="text-muted" role="status">
          {copied === 'yes' ? 'Copied.' : copied === 'no' ? 'Copy did not work here: select the text and copy it by hand.' : ''}
        </span>
      </div>
    </div>
  );
}

/** A refusal in plain words. */
export function Problem({ text }: { text: string | null }) {
  return text === null ? null : <Banner tone="error">{text}</Banner>;
}

/** A kit job's lines as they arrive (text only, never markup). */
export function JobLog({ lines, label }: { lines: readonly string[]; label: string }) {
  const box = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const node = box.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [lines]);
  if (lines.length === 0) return null;
  return (
    <ol className="host-log mono" ref={box} aria-label={label} aria-live="polite" tabIndex={0} data-testid="host-log">
      {lines.map((line, i) => <li key={i}>{line}</li>)}
    </ol>
  );
}

/** Where the flow is: each step's name, the current one marked for screen readers too. */
export function StepList({ steps, current }: { steps: ReadonlyArray<{ id: string; label: string }>; current: string }) {
  const at = steps.findIndex((step) => step.id === current);
  return (
    <ol className="host-steps" aria-label="Steps">
      {steps.map((step, i) => (
        <li key={step.id} className={i === at ? 'host-steps__item is-current' : i < at ? 'host-steps__item is-done' : 'host-steps__item'}
          aria-current={i === at ? 'step' : undefined}>
          {step.label}
        </li>
      ))}
    </ol>
  );
}
