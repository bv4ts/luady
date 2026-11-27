import type { HelperDTO } from '@luady/shared';
import { helpersLine } from './step-text.js';

/** "2 helpers: Explore, general-purpose"; nothing while the agent has no helper running. */
export function Helpers({ helpers }: { helpers: readonly HelperDTO[] }) {
  const line = helpersLine(helpers);
  return line === null ? null : <p className="agent-helpers" dir="auto">{line}</p>;
}
