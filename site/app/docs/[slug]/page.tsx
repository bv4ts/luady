import type { Metadata } from 'next';
import { DocsPage, docs, docsMetadata } from '../../../components/docs/DocsPage';
import '../../docs.css';

/** Only the pages docs/ has: every Markdown file in it, except README.md (the overview at /docs/). */
export const dynamicParams = false;

export function generateStaticParams(): { slug: string }[] {
  return docs().files.filter((file: string) => file !== 'README.md').map((file: string) => ({ slug: file.replace(/\.md$/, '') }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return docsMetadata(`${slug}.md`);
}

export default async function DocsSlugPage({ params }: Props) {
  const { slug } = await params;
  return <DocsPage file={`${slug}.md`} />;
}
