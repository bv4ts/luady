import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '../../lib/report.js';

interface Props {
  readonly fallback: ReactNode;
  readonly children: ReactNode;
}

/** Catches a crash or a chunk that failed to load inside the office, so the owner never gets a blank page. */
export class OfficeBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportError('office view', { error, componentStack: info.componentStack });
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
