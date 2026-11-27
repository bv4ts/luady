export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly SegmentOption<T>[]; onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="tab" className="segmented__item"
          aria-selected={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
