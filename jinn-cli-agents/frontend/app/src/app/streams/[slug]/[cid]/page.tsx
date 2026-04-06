import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getVentureBySlug } from '@/lib/ventures';
import {
  fetchWorkstreamRootArtifactByCidAction,
  fetchArtifactContentAction,
} from '@/app/actions';
import { MarkdownField } from '@/components/markdown-field';
import { Badge } from '@/components/ui/badge';

export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; cid: string }>;
}): Promise<Metadata> {
  const { slug, cid } = await params;
  const venture = await getVentureBySlug(slug);
  const artifact = venture?.root_workstream_id
    ? await fetchWorkstreamRootArtifactByCidAction(venture.root_workstream_id, cid)
    : null;

  const title = artifact?.name || 'Article';
  const streamName = venture?.name || 'Stream';

  return {
    title: `${title} — ${streamName} | Jinn`,
    description: `${title} from ${streamName}`,
    openGraph: {
      title,
      description: `${title} from ${streamName}`,
    },
  };
}

/** Format timestamp as a readable date */
function formatDate(timestamp?: string): string {
  if (!timestamp) return '';
  const date = new Date(Number(timestamp) * 1000);
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ slug: string; cid: string }>;
}) {
  const { slug, cid } = await params;

  const venture = await getVentureBySlug(slug);
  if (!venture || !venture.root_workstream_id) {
    notFound();
  }

  const [artifact, contentResult] = await Promise.all([
    fetchWorkstreamRootArtifactByCidAction(venture.root_workstream_id, cid),
    fetchArtifactContentAction(cid),
  ]);

  if (!artifact) {
    notFound();
  }

  const content = contentResult?.content || null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 space-y-8">
      {/* Back link */}
      <Link
        href={`/streams/${slug}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3 w-3" />
        {venture.name}
      </Link>

      {/* Article header */}
      <header className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className="text-[10px] uppercase">
            {artifact.topic}
          </Badge>
          {artifact.blockTimestamp && (
            <time>{formatDate(artifact.blockTimestamp)}</time>
          )}
        </div>
        <h1 className="text-3xl font-bold tracking-tight leading-tight">
          {artifact.name || 'Untitled'}
        </h1>
        {artifact.jobName && (
          <p className="text-sm text-muted-foreground">
            by {artifact.jobName}
          </p>
        )}
      </header>

      {/* Article content */}
      <article className="prose-sm">
        {content ? (
          <MarkdownField content={content} showRawToggle={false} />
        ) : (
          <p className="text-muted-foreground text-sm">
            Content could not be loaded.
          </p>
        )}
      </article>
    </div>
  );
}
