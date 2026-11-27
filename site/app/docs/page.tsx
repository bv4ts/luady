import type { Metadata } from 'next';
import { DocsPage, docsMetadata } from '../../components/docs/DocsPage';
import '../docs.css';

/** The docs overview, from docs/README.md. */
export const metadata: Metadata = docsMetadata('README.md');

export default function DocsHome() {
  return <DocsPage file="README.md" />;
}
