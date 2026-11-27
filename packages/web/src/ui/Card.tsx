import { useId, type ReactNode } from 'react';

export function Card({ title, subtitle, actions, className, children }: {
  title?: string; subtitle?: ReactNode; actions?: ReactNode; className?: string; children?: ReactNode;
}) {
  const id = useId();
  return (
    <section className={className ? `card ${className}` : 'card'} aria-labelledby={title ? id : undefined}>
      {title || actions ? (
        <header className="card__header">
          <div className="card__heading">
            {title ? <h2 className="card__title" id={id}>{title}</h2> : null}
            {subtitle ? <p className="card__subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="card__actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}
