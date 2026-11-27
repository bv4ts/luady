import { useId, type ComponentProps, type ReactNode } from 'react';

interface FieldChrome {
  label: string;
  hint?: string | undefined;
  error?: string | null | undefined;
}

function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter((value): value is string => value !== null);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

function FieldFrame({ id, label, hint, error, children }: FieldChrome & { id: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>{label}</label>
      {children}
      {hint ? <p className="field__hint" id={`${id}-hint`}>{hint}</p> : null}
      {error ? <p className="field__error" id={`${id}-error`} role="alert">{error}</p> : null}
    </div>
  );
}

export function TextField({ label, hint, error, className, ...input }: Omit<ComponentProps<'input'>, 'id'> & FieldChrome) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error}>
      <input id={id} className={className ? `input ${className}` : 'input'} aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)} {...input} />
    </FieldFrame>
  );
}

export function TextAreaField({ label, hint, error, className, ...area }: Omit<ComponentProps<'textarea'>, 'id'> & FieldChrome) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error}>
      <textarea id={id} className={className ? `textarea ${className}` : 'textarea'} aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)} {...area} />
    </FieldFrame>
  );
}

export interface SelectOption { readonly value: string; readonly label: string; readonly disabled?: boolean }

export function SelectField({ label, hint, error, options, className, ...select }:
  Omit<ComponentProps<'select'>, 'id' | 'children'> & FieldChrome & { options: readonly SelectOption[] }) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error}>
      <select id={id} className={className ? `select ${className}` : 'select'} aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)} {...select}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
        ))}
      </select>
    </FieldFrame>
  );
}

export function Switch({ label, description, checked, onChange, disabled }: {
  label: string; description?: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className="switch">
      <span className="switch__text">
        <span className="switch__label" id={`${id}-label`}>{label}</span>
        {description ? <span className="switch__desc" id={`${id}-desc`}>{description}</span> : null}
      </span>
      <input type="checkbox" role="switch" className="switch__input" checked={checked} disabled={disabled}
        aria-labelledby={`${id}-label`} aria-describedby={description ? `${id}-desc` : undefined}
        onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}
