import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { getVentureBySlug } from '@/lib/ventures';
import { fetchWorkstreamRootArtifactsAction } from '@/app/actions';
import { formatTimeAgo } from '@/lib/artifact-utils';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

export const revalidate = 30;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const venture = await getVentureBySlug(slug);
  if (!venture) return {};

  const description = venture.description?.slice(0, 160) || 'A content stream on Jinn';

  return {
    title: `${venture.name} — Stream | Jinn`,
    description,
    openGraph: {
      title: venture.name,
      description,
    },
  };
}

/** Extract a plain-text excerpt from contentPreview or artifact name */
function getExcerpt(artifact: { contentPreview?: string; name: string }, maxLength = 200): string {
  const raw = artifact.contentPreview || artifact.name;
  if (!raw) return '';

  // Try to parse JSON and extract .content field
  try {
    const parsed = JSON.parse(raw);
    const text = typeof parsed.content === 'string' ? parsed.content : raw;
    // Strip markdown formatting for clean excerpt
    const plain = text
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^[-*]\s+/gm, '')
      .trim();
    return plain.length > maxLength ? plain.slice(0, maxLength) + '...' : plain;
  } catch {
    const plain = raw
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .trim();
    return plain.length > maxLength ? plain.slice(0, maxLength) + '...' : plain;
  }
}

/** Format timestamp as a readable date */
function formatDate(timestamp?: string): string {
  if (!timestamp) return '';
  const date = new Date(Number(timestamp) * 1000);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export default async function StreamDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const venture = await getVentureBySlug(slug);

  if (!venture || !venture.root_workstream_id) {
    notFound();
  }

  const artifacts = await fetchWorkstreamRootArtifactsAction(
    venture.root_workstream_id
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 space-y-8">
      {/* Stream header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">{venture.name}</h1>
        {venture.description && (
          <p className="text-muted-foreground">{venture.description}</p>
        )}
      </div>

      <Separator />

      {/* Article feed */}
      {artifacts.length === 0 ? (
        <p className="text-muted-foreground text-sm py-8 text-center">
          No content published yet. Check back soon.
        </p>
      ) : (
        <div className="space-y-10">
          {artifacts.map((artifact) => (
            <article key={artifact.id}>
              <Link
                href={`/streams/${slug}/${artifact.cid}`}
                className="group block space-y-2"
              >
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary" className="text-[10px] uppercase">
                    {artifact.topic}
                  </Badge>
                  {artifact.blockTimestamp && (
                    <time>{formatDate(artifact.blockTimestamp)}</time>
                  )}
                  {artifact.blockTimestamp && (
                    <span className="text-muted-foreground/50">
                      ({formatTimeAgo(artifact.blockTimestamp)})
                    </span>
                  )}
                </div>
                <h2 className="text-lg font-semibold group-hover:text-primary transition-colors">
                  {artifact.name || 'Untitled'}
                </h2>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {getExcerpt(artifact)}
                </p>
                <span className="inline-flex items-center gap-1 text-sm text-primary group-hover:underline">
                  Read more <ArrowRight className="h-3 w-3" />
                </span>
              </Link>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
