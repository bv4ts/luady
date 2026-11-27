import type { ComponentProps } from 'react';
import { Icon, type IconName } from './Icon.js';
import { Spinner } from './Spinner.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  busy?: boolean;
  icon?: IconName;
}

export function Button({
  variant = 'secondary', size = 'md', busy = false, icon, className, children, disabled, type = 'button', ...rest
}: ButtonProps) {
  const classes = ['btn', `btn--${variant}`, size === 'sm' ? 'btn--sm' : null, className ?? null].filter(Boolean).join(' ');
  return (
    <button type={type} className={classes} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <Spinner size="sm" /> : icon ? <Icon name={icon} /> : null}
      {children === undefined || children === null ? null : <span className="btn__label">{children}</span>}
    </button>
  );
}
