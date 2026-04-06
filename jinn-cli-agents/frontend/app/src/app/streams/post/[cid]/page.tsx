import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { MarkdownField } from '@/components/markdown-field';
import {
  fetchArtifactByCidAction,
  fetchArtifactContentAction,
} from '@/app/actions';

export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ cid: string }>;
}): Promise<Metadata> {
  const { cid: rawCid } = await params;
  const cid = decodeURIComponent(rawCid);
  const artifact = await fetchArtifactByCidAction(cid);
  const title = artifact?.name || 'Article';

  return {
    title: `${title} | Streams | Jinn`,
    description: `Read ${title} on Jinn Streams`,
    openGraph: {
      title,
      description: `Read ${title} on Jinn Streams`,
    },
  };
}

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

export default async function StreamPostPage({
  params,
}: {
  params: Promise<{ cid: string }>;
}) {
  const { cid: rawCid } = await params;
  const cid = decodeURIComponent(rawCid);

  const [artifact, contentResult] = await Promise.all([
    fetchArtifactByCidAction(cid),
    fetchArtifactContentAction(cid),
  ]);

  if (!artifact && !contentResult) {
    notFound();
  }

  const content = contentResult?.content || null;
  const title = artifact?.name || 'Untitled';
  const topic = artifact?.topic || 'CONTENT';
  const blockTimestamp = artifact?.blockTimestamp;
  const jobName = artifact?.jobName;

  const explorerBase = process.env.NEXT_PUBLIC_EXPLORER_URL || 'https://explorer.jinn.network';
  const workstreamId = (artifact as Record<string, unknown> | null)?.workstreamId as string | undefined;
  const requestId = artifact?.requestId;
  const explorerHref = workstreamId
    ? `${explorerBase}/workstreams/${workstreamId}`
    : requestId
      ? `${explorerBase}/requests/${requestId}`
      : null;

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 py-8">
      <Link
        href="/streams"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        Streams
      </Link>

      <header className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className="text-[10px] uppercase">
            {topic}
          </Badge>
          {blockTimestamp && (
            <time>{formatDate(blockTimestamp)}</time>
          )}
          {explorerHref && (
            <a
              href={explorerHref}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-muted-foreground/60 transition-colors hover:text-foreground"
            >
              View on Explorer
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

        <h1 className="text-3xl font-bold leading-tight tracking-tight">
          {title}
        </h1>
        {jobName && (
          <p className="text-sm text-muted-foreground">by {jobName}</p>
        )}
      </header>

      <article className="prose-sm">
        {content ? (
          <MarkdownField content={content} showRawToggle={false} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Content could not be loaded.
          </p>
        )}
      </article>
    </div>
  );
}
