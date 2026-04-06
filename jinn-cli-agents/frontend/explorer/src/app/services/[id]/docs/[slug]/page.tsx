import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { SiteHeader } from '@/components/site-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { getService, getDocBySlug, getDocs, type ServiceDoc } from '@/lib/ventures-services';
import { Book, ChevronLeft, ExternalLink, Clock, User } from 'lucide-react';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

interface DocPageProps {
  params: Promise<{ id: string; slug: string }>;
}

export async function generateMetadata({ params }: DocPageProps): Promise<Metadata> {
  const { id, slug } = await params;
  const doc = await getDocBySlug(id, slug);
  const service = await getService(id);
  return {
    title: doc ? `${doc.title} - ${service?.name || 'Service'}` : 'Documentation',
    description: doc?.title || 'Service documentation',
  };
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function DocTypeBadge({ type }: { type: ServiceDoc['doc_type'] }) {
  const labels: Record<ServiceDoc['doc_type'], string> = {
    readme: 'README',
    guide: 'Guide',
    reference: 'Reference',
    tutorial: 'Tutorial',
    changelog: 'Changelog',
    api: 'API Docs',
    architecture: 'Architecture',
    runbook: 'Runbook',
    other: 'Documentation',
  };
  return <Badge variant="secondary">{labels[type]}</Badge>;
}

// Simple markdown-like rendering (basic support)
function MarkdownContent({ content, format }: { content: string; format: ServiceDoc['content_format'] }) {
  if (format === 'html') {
    return <div className="prose prose-sm dark:prose-invert max-w-none" dangerouslySetInnerHTML={{ __html: content }} />;
  }

  // Basic markdown rendering - for production, use a proper markdown library
  const lines = content.split('\n');
  const elements: ReactNode[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let codeBlockLang = '';

  lines.forEach((line, i) => {
    // Code blocks
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <pre key={i} className="bg-muted p-4 rounded-lg overflow-x-auto text-sm font-mono my-4">
            <code>{codeBlockContent.join('\n')}</code>
          </pre>
        );
        codeBlockContent = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeBlockLang = line.slice(3);
      }
      return;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      return;
    }

    // Headers
    if (line.startsWith('# ')) {
      elements.push(<h1 key={i} className="text-2xl font-bold mt-8 mb-4">{line.slice(2)}</h1>);
      return;
    }
    if (line.startsWith('## ')) {
      elements.push(<h2 key={i} className="text-xl font-semibold mt-6 mb-3">{line.slice(3)}</h2>);
      return;
    }
    if (line.startsWith('### ')) {
      elements.push(<h3 key={i} className="text-lg font-medium mt-4 mb-2">{line.slice(4)}</h3>);
      return;
    }

    // Lists
    if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(
        <li key={i} className="ml-4 list-disc">{line.slice(2)}</li>
      );
      return;
    }

    // Inline code
    const processedLine = line.replace(/`([^`]+)`/g, '<code class="bg-muted px-1 py-0.5 rounded text-sm font-mono">$1</code>');

    // Bold
    const withBold = processedLine.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Empty lines
    if (line.trim() === '') {
      elements.push(<div key={i} className="h-4" />);
      return;
    }

    // Regular paragraphs
    elements.push(
      <p key={i} className="my-2 text-muted-foreground" dangerouslySetInnerHTML={{ __html: withBold }} />
    );
  });

  return <div className="prose prose-sm dark:prose-invert max-w-none">{elements}</div>;
}

// Sidebar navigation for other docs
function DocsSidebar({ docs, currentSlug, serviceId }: { docs: ServiceDoc[]; currentSlug: string; serviceId: string }) {
  const publishedDocs = docs.filter(d => d.status === 'published');

  if (publishedDocs.length <= 1) return null;

  return (
    <Card className="sticky top-4">
      <CardContent className="pt-4">
        <h3 className="font-medium mb-3 flex items-center gap-2">
          <Book className="h-4 w-4" />
          Documentation
        </h3>
        <nav className="space-y-1">
          {publishedDocs.map((doc) => (
            <Link
              key={doc.id}
              href={`/services/${serviceId}/docs/${doc.slug}`}
              className={`block px-2 py-1.5 text-sm rounded-md transition-colors ${
                doc.slug === currentSlug
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {doc.title}
            </Link>
          ))}
        </nav>
      </CardContent>
    </Card>
  );
}

export default async function DocPage({ params }: DocPageProps) {
  const { id, slug } = await params;

  const [doc, service, allDocs] = await Promise.all([
    getDocBySlug(id, slug),
    getService(id),
    getDocs(id),
  ]);

  if (!doc || !service) {
    notFound();
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Services', href: '/services' },
          { label: service.name, href: `/services/${service.id}` },
          { label: 'Docs' },
          { label: doc.title },
        ]}
      />

      <main className="flex-1 py-6">
        <div className="container mx-auto px-4">
          <div className="flex gap-8">
            {/* Main content */}
            <article className="flex-1 max-w-3xl">
              {/* Back link */}
              <Link
                href={`/services/${service.id}`}
                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary mb-6"
              >
                <ChevronLeft className="h-4 w-4" />
                Back to {service.name}
              </Link>

              {/* Doc header */}
              <header className="mb-8">
                <div className="flex items-center gap-2 mb-2">
                  <DocTypeBadge type={doc.doc_type} />
                  {doc.version && <Badge variant="outline">v{doc.version}</Badge>}
                </div>
                <h1 className="text-3xl font-bold mb-4">{doc.title}</h1>
                <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                  {doc.author && (
                    <span className="flex items-center gap-1">
                      <User className="h-4 w-4" />
                      {doc.author}
                    </span>
                  )}
                  {doc.published_at && (
                    <span className="flex items-center gap-1">
                      <Clock className="h-4 w-4" />
                      Published {formatDate(doc.published_at)}
                    </span>
                  )}
                  {doc.external_url && (
                    <a
                      href={doc.external_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-primary hover:underline"
                    >
                      <ExternalLink className="h-4 w-4" />
                      External link
                    </a>
                  )}
                </div>
                {doc.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-3">
                    {doc.tags.map((tag) => (
                      <span key={tag} className="text-xs bg-muted px-2 py-0.5 rounded">{tag}</span>
                    ))}
                  </div>
                )}
              </header>

              {/* Doc content */}
              <div className="border-t pt-8">
                <MarkdownContent content={doc.content} format={doc.content_format} />
              </div>

              {/* Footer */}
              <footer className="mt-12 pt-6 border-t text-sm text-muted-foreground">
                <p>Last updated: {formatDate(doc.updated_at)}</p>
              </footer>
            </article>

            {/* Sidebar */}
            <aside className="hidden lg:block w-64 shrink-0">
              <DocsSidebar docs={allDocs} currentSlug={slug} serviceId={id} />
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}
