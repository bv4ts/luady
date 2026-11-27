/** A floor plan: the office map. Same drawing rules as ui/Icon. */
export function OfficeIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M9.5 4v5.5M9.5 13v7M3.5 12h3M14.5 4v5.5M14.5 13v7M17.5 12h3" />
    </svg>
  );
}
