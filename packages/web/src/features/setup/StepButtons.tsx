import { Button } from '../../ui/Button.js';

export interface StepButtonsProps {
  /** Null when there is nothing to keep yet: only "Skip for now" is offered. */
  readonly onNext: (() => void) | null;
  readonly onSkip: () => void;
  readonly busy?: boolean;
  /** Opened from Settings: one plain "Done" instead (the setup state does not move there). */
  readonly fromSettings?: boolean;
}

/** A step's way on: "Next" (when there is something to keep) and "Skip for now" (always safe here). */
export function StepButtons({ onNext, onSkip, busy = false, fromSettings = false }: StepButtonsProps) {
  if (fromSettings) {
    return <div className="setup-actions"><Button variant="primary" onClick={onSkip}>Done</Button></div>;
  }
  return (
    <div className="setup-actions">
      {onNext !== null ? <Button variant="primary" busy={busy} data-testid="setup-next" onClick={onNext}>Next</Button> : null}
      <Button variant={onNext === null ? 'primary' : 'ghost'} disabled={busy} data-testid="setup-skip" onClick={onSkip}>Skip for now</Button>
    </div>
  );
}
