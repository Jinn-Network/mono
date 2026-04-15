import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { User, Bot, ExternalLink, CalendarClock, Clock, List, FileText, RefreshCw } from 'lucide-react';
import { getVentureBySlug } from '@/lib/ventures';
import type { Venture, ScheduleEntry } from '@/lib/ventures';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { VentureDashboard } from '@/components/ventures/venture-dashboard';
import { fetchWorkstreamActivityAction, fetchWorkstreamArtifactsAction } from '@/app/actions';
import { getServiceInstance, getRootJobDefinition, getRootRequest, getMeasurementArtifacts, getServiceOutputs, getWorkstreamActivity } from '@/lib/ventures/service-queries';
import type { ServiceOutput } from '@/lib/ventures/service-types';
import { fetchIpfsContent } from '@/lib/subgraph';
import { parseInvariants, matchInvariantsWithMeasurements, countByStatus } from '@jinn/shared-ui';

export const revalidate = 30;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const venture = await getVentureBySlug(slug);
  if (!venture) return {};

  const description = venture.description
    ? venture.description.slice(0, 160)
    : 'A content agent on Jinn';

  const ogParams = new URLSearchParams({
    name: venture.name,
    description: description,
    status: venture.status,
  });

  const ogImage = `/api/og?${ogParams.toString()}`;

  return {
    title: venture.name,
    description,
    openGraph: {
      title: venture.name,
      description,
      images: [{ url: ogImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title: venture.name,
      description,
      images: [ogImage],
    },
  };
}

/** Dashboard skeleton shown during Suspense loading */
function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Skeleton className="h-10 w-28" />
        <Skeleton className="h-10 w-28" />
        <Skeleton className="h-10 w-28" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <Skeleton className="h-[500px] w-full rounded-lg" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-60 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}

/** Server component that fetches all dashboard data */
async function VentureDashboardSection({
  workstreamId,
}: {
  workstreamId: string;
}) {
  const [rootJobDef, rootRequest, measurementArtifacts, outputArtifacts, activityData] = await Promise.all([
    getRootJobDefinition(workstreamId),
    getRootRequest(workstreamId),
    getMeasurementArtifacts(workstreamId),
    getServiceOutputs(workstreamId),
    getWorkstreamActivity(workstreamId),
  ]);

  // Parse blueprint from IPFS if available
  let blueprintText = rootJobDef?.blueprint || '';
  if (!blueprintText && rootRequest?.ipfsHash) {
    try {
      const content = await fetchIpfsContent(rootRequest.ipfsHash, rootRequest.id);
      if (content) {
        const parsed = JSON.parse(content.content);
        blueprintText = typeof parsed.blueprint === 'string'
          ? parsed.blueprint
          : JSON.stringify(parsed.blueprint || parsed);
      }
    } catch {
      // Ignore IPFS fetch errors
    }
  }

  const rawInvariants = parseInvariants(blueprintText);
  const invariants = matchInvariantsWithMeasurements(rawInvariants, measurementArtifacts);
  const statusCounts = countByStatus(invariants);

  let liveOutputUrl: string | null = null;
  let telegramUrl: string | null = null;
  let primaryOutput: ServiceOutput | null = null;

  for (const artifact of outputArtifacts) {
    if (artifact.contentPreview) {
      try {
        const output: ServiceOutput = JSON.parse(artifact.contentPreview);
        if (output.type === 'website' && output.primary) {
          liveOutputUrl = output.url;
          primaryOutput = output;
        }
        if (output.label?.toLowerCase().includes('telegram')) {
          telegramUrl = output.url;
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  return (
    <VentureDashboard
      liveOutputUrl={liveOutputUrl}
      telegramUrl={telegramUrl}
      activityData={activityData}
      workstreamId={workstreamId}
      invariants={invariants}
      statusCounts={statusCounts}
      primaryOutput={primaryOutput}
      fetchActivity={fetchWorkstreamActivityAction}
      fetchArtifacts={fetchWorkstreamArtifactsAction}
    />
  );
}

// Compute next N UTC occurrences of a cron expression.
// Supports: "0 H * * *", "0 */N * * *", "0 H * * DOW"
function getNextCronRuns(cron: string, count = 5): Date[] {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return [];
  const [, hourPart, , , dowPart] = parts;
  const runs: Date[] = [];

  const base = new Date();
  // Advance past current minute to avoid "now" matches
  base.setUTCSeconds(0, 0);
  base.setUTCMinutes(base.getUTCMinutes() + 1);

  if (dowPart !== '*') {
    // Weekly: specific day of week
    const targetDow = parseInt(dowPart);
    const targetHour = parseInt(hourPart);
    const cursor = new Date(base);
    cursor.setUTCHours(targetHour, 0, 0, 0);
    let daysUntil = (targetDow - cursor.getUTCDay() + 7) % 7;
    if (daysUntil === 0 && cursor <= base) daysUntil = 7;
    cursor.setUTCDate(cursor.getUTCDate() + daysUntil);
    for (let i = 0; i < count; i++) {
      runs.push(new Date(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
    return runs;
  }

  if (hourPart.startsWith('*/')) {
    // Every N hours
    const intervalHours = parseInt(hourPart.slice(2));
    const cursor = new Date(base);
    cursor.setUTCMinutes(0, 0, 0);
    const currentHour = cursor.getUTCHours();
    const nextHour = Math.ceil((currentHour + (base.getUTCMinutes() > 0 ? 1 : 0)) / intervalHours) * intervalHours;
    cursor.setUTCHours(nextHour, 0, 0, 0);
    for (let i = 0; i < count; i++) {
      if (cursor.getUTCHours() >= 24) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        cursor.setUTCHours(0, 0, 0, 0);
      }
      runs.push(new Date(cursor));
      cursor.setUTCHours(cursor.getUTCHours() + intervalHours);
    }
    return runs;
  }

  // Daily at fixed hour
  const targetHour = parseInt(hourPart);
  const cursor = new Date(base);
  cursor.setUTCHours(targetHour, 0, 0, 0);
  if (cursor <= base) cursor.setUTCDate(cursor.getUTCDate() + 1);
  for (let i = 0; i < count; i++) {
    runs.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return runs;
}

function formatRunDate(date: Date, now: Date): string {
  const diffMs = date.getTime() - now.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  const timeStr = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';

  if (diffHours < 1) return `in less than an hour (${timeStr})`;
  if (diffHours < 24) return `today at ${timeStr}`;
  if (diffHours < 48) return `tomorrow at ${timeStr}`;

  const dayStr = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${dayStr} at ${timeStr}`;
}

function formatCronLabel(cron: string): string {
  const map: Record<string, string> = {
    '0 */6 * * *': 'Every 6 hours',
    '0 */12 * * *': 'Every 12 hours',
    '0 9 * * *': 'Daily at 09:00 UTC',
    '0 9 * * 1': 'Weekly on Mondays at 09:00 UTC',
  };
  return map[cron.trim()] ?? cron;
}

/** Pending state for ventures awaiting workstream dispatch */
interface TemplateConfig {
  sources?: string[];
  lookbackPeriod?: string;
  contentBrief?: string;
  formatBrief?: string;
  outputFormat?: string;
}

function PendingVentureView({ venture }: { venture: Venture }) {
  const templateConfig = (venture.blueprint as { templateConfig?: TemplateConfig } | null)?.templateConfig;
  const schedule: ScheduleEntry | undefined = venture.dispatch_schedule?.[0];
  const now = new Date();
  const nextRuns = schedule?.cron ? getNextCronRuns(schedule.cron, 5) : [];
  const firstRun = nextRuns[0];

  return (
    <div className="space-y-4">
      {/* Next-run banner */}
      {firstRun ? (
        <div className="flex items-center gap-3 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3">
          <CalendarClock className="h-5 w-5 text-blue-400 shrink-0" />
          <div>
            <p className="text-sm font-medium text-blue-300">
              First agent run {formatRunDate(firstRun, now)}
            </p>
            {schedule?.cron && (
              <p className="text-xs text-blue-400/70 mt-0.5">{formatCronLabel(schedule.cron)}</p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-secondary/10 px-4 py-3">
          <Clock className="h-5 w-5 text-muted-foreground shrink-0" />
          <p className="text-sm text-muted-foreground">No schedule configured — agent will be dispatched manually.</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Schedule timeline */}
        {nextRuns.length > 0 && (
          <Card className="border-border/50">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <RefreshCw className="h-4 w-4 text-muted-foreground" />
                Upcoming runs
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <ol className="space-y-2">
                {nextRuns.map((run, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm">
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${i === 0 ? 'bg-blue-400' : 'bg-muted-foreground/40'}`} />
                    <span className={i === 0 ? 'text-foreground' : 'text-muted-foreground'}>
                      {run.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}
                      {' '}
                      <span className="text-xs opacity-70">
                        {run.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        )}

        {/* Sources */}
        {templateConfig?.sources && templateConfig.sources.length > 0 && (
          <Card className="border-border/50 md:col-span-2">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <List className="h-4 w-4 text-muted-foreground" />
                Sources ({templateConfig.sources.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <ul className="space-y-1 columns-2 gap-4">
                {templateConfig.sources.map((s, i) => (
                  <li key={i} className="text-xs text-muted-foreground truncate break-inside-avoid">
                    <a href={s} target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">
                      {s.replace(/^https?:\/\//, '')}
                    </a>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {/* Configuration */}
        {templateConfig && (
          <Card className="border-border/50 md:col-span-3">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                Configuration
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {templateConfig.lookbackPeriod && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Lookback window</p>
                    <p className="text-sm">{templateConfig.lookbackPeriod as string}</p>
                  </div>
                )}
                {templateConfig.outputFormat && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Output format</p>
                    <p className="text-sm">{templateConfig.outputFormat as string}</p>
                  </div>
                )}
                {templateConfig.contentBrief && (
                  <div className="sm:col-span-2">
                    <p className="text-xs text-muted-foreground mb-1">Content brief</p>
                    <p className="text-sm text-muted-foreground leading-relaxed">{templateConfig.contentBrief as string}</p>
                  </div>
                )}
                {templateConfig.formatBrief && (
                  <div className="sm:col-span-2">
                    <p className="text-xs text-muted-foreground mb-1">Style brief</p>
                    <p className="text-sm text-muted-foreground leading-relaxed">{templateConfig.formatBrief as string}</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

export default async function VentureDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const venture = await getVentureBySlug(slug);

  if (!venture) {
    notFound();
  }

  const hasWorkstream = !!venture.root_workstream_id;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{venture.name}</h1>
          <Badge variant="outline" className="text-xs">Content</Badge>
        </div>
        {venture.description && (
          <p className="text-muted-foreground">{venture.description}</p>
        )}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {venture.creator_type === 'delegate' ? (
            <Bot className="h-3 w-3" />
          ) : (
            <User className="h-3 w-3" />
          )}
          <span>Created by</span>
          <a
            href={`https://basescan.org/address/${venture.owner_address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-primary hover:underline"
          >
            {venture.owner_address.slice(0, 6)}...{venture.owner_address.slice(-4)}
            <ExternalLink className="inline h-3 w-3 ml-0.5" />
          </a>
        </div>
      </div>

      {/* Dashboard (if workstream exists) */}
      {hasWorkstream && (
        <Suspense fallback={<DashboardSkeleton />}>
          <VentureDashboardSection
            workstreamId={venture.root_workstream_id!}
          />
        </Suspense>
      )}

      {/* Pending state (no workstream yet) */}
      {!hasWorkstream && <PendingVentureView venture={venture} />}
    </div>
  );
}
