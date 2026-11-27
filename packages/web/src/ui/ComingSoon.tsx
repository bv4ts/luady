/** What a section without content yet renders: one quiet line. */
export const COMING_SOON = 'Coming in this build';

export function ComingSoon({ testId }: { testId: string }) {
  return <p className="text-muted" data-testid={testId}>{COMING_SOON}</p>;
}
