export function Spinner({ size = 'md', label }: { size?: 'sm' | 'md' | 'lg'; label?: string }) {
  const className = `spinner spinner--${size}`;
  return label
    ? <span className={className} role="status" aria-label={label} />
    : <span className={className} aria-hidden="true" />;
}
