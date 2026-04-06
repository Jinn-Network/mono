import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { SiteHeader } from '@/components/site-header';
import { Card, CardContent } from '@/components/ui/card';
import { VentureDashboard } from '@/components/ventures/venture-dashboard';
import { VentureScheduleDashboard } from '@/components/ventures/venture-schedule-dashboard';
import {
  getServiceInstance,
  getRootJobDefinition,
  getRootRequest,
  getMeasurementArtifacts,
  getServiceOutputs,
  getWorkstreamActivity,
} from '@/lib/ventures/service-queries';
import { getVenture, getVentureByWorkstreamId } from '@/lib/ventures-services';
import { getVentureWorkstreams } from '@/lib/ventures/venture-queries';
import { fetchIpfsContent, type Artifact, type JobDefinition } from '@/lib/subgraph';
import {
  parseInvariants,
  determineHealthStatus,
  getInvariantDisplayText,
  isSystemInvariant,
  parseMeasurement as sharedParseMeasurement,
  toInvariantMeasurement,
  countByStatus,
  type Invariant,
  type LegacyInvariant,
  type InvariantMeasurement,
  type HealthStatus,
} from '@jinn/shared-ui';
import type { ServiceOutput } from '@/lib/ventures/service-types';
import type { InvariantWithMeasurement } from '@/components/ventures/invariant-list';
import { fetchWorkstreamActivityAction } from '../actions';

/**
 * Parse SERVICE_OUTPUT artifact contentPreview to get output metadata
 */
function parseServiceOutput(artifact: Artifact): ServiceOutput | null {
  if (!artifact.contentPreview) return null;
  try {
    const parsed = JSON.parse(artifact.contentPreview);
    if (parsed.url && typeof parsed.url === 'string') {
      return {
        type: parsed.type || 'website',
        url: parsed.url,
        label: parsed.label,
        primary: parsed.primary
      };
    }
  } catch {
    // Not valid JSON, ignore
  }
  return null;
}

/**
 * Parse measurement from artifact contentPreview JSON.
 */
function parseMeasurement(artifact: Artifact): InvariantMeasurement | null {
  const structured = sharedParseMeasurement(artifact);
  if (!structured) return null;
  return toInvariantMeasurement(structured);
}

/**
 * Match invariants with their latest measurements from artifacts.
 */
function matchInvariantsWithMeasurements(
  invariants: (Invariant | LegacyInvariant)[],
  artifacts: Artifact[]
): InvariantWithMeasurement[] {
  // Parse all measurements from artifacts
  const measurements = new Map<string, InvariantMeasurement>();
  for (const artifact of artifacts) {
    const measurement = parseMeasurement(artifact);
    if (measurement) {
      // Keep the latest measurement (artifacts are sorted desc by timestamp)
      if (!measurements.has(measurement.invariantId)) {
        measurements.set(measurement.invariantId, measurement);
      }
    }
  }

  const displayInvariants = invariants.filter(inv => !isSystemInvariant(inv));

  // Match each invariant with its measurement
  return displayInvariants.map(inv => {
    const measurement = measurements.get(inv.id);
    const status = determineHealthStatus(inv, measurement);
    return {
      id: inv.id,
      invariant: inv,
      text: getInvariantDisplayText(inv),
      measurement,
      latestScore: measurement?.score,
      latestContext: measurement?.context,
      lastMeasuredAt: measurement?.timestamp,
      status
    };
  });
}

interface VenturePageProps {
  params: Promise<{ id: string }>;
}

interface VentureDetailProps {
  id: string;
  initialTab?: 'dashboard' | 'health' | 'activity' | 'work-tree' | 'artifacts';
  initialSelectedJobId?: string | null;
}

export async function VentureDetail({ id, initialTab, initialSelectedJobId }: VentureDetailProps) {
  const instance = await getServiceInstance(id);

  if (!instance) {
    notFound();
  }

  // Fetch all data in parallel
  const [rootJobDef, rootRequest, measurementArtifacts, outputArtifacts, activityData, venture] = await Promise.all([
    getRootJobDefinition(id),
    getRootRequest(id),
    getMeasurementArtifacts(id),
    getServiceOutputs(id),
    getWorkstreamActivity(id),
    getVentureByWorkstreamId(id)
  ]);

  // Parse service outputs from artifacts
  const serviceOutputs = outputArtifacts
    .map(parseServiceOutput)
    .filter((o): o is ServiceOutput => o !== null);
  const primaryOutput = serviceOutputs.find(o => o.primary) || serviceOutputs[0] || null;

  // Parse invariants from blueprint
  let blueprintJson: unknown = null;
  let rawBlueprintContent: string | null = null;

  // Try to fetch from IPFS first (source of truth)
  if (rootRequest?.ipfsHash) {
    try {
      const ipfsResult = await fetchIpfsContent(rootRequest.ipfsHash);
      if (ipfsResult) {
        const parsed = JSON.parse(ipfsResult.content);
        rawBlueprintContent = parsed.blueprint || parsed.prompt || ipfsResult.content;
      }
    } catch (e) {
      console.error('Failed to fetch/parse IPFS content', e);
    }
  }

  // Fallback to subgraph blueprint if IPFS failed or missing
  if (!rawBlueprintContent && rootJobDef?.blueprint) {
    rawBlueprintContent = rootJobDef.blueprint;
  }

  if (rawBlueprintContent) {
    try {
      blueprintJson = typeof rawBlueprintContent === 'string'
        ? JSON.parse(rawBlueprintContent)
        : rawBlueprintContent;
    } catch {
      // Invalid JSON, might be raw text, ignore for invariants
    }
  }

  const invariants = parseInvariants(blueprintJson);
  const invariantsWithMeasurements = matchInvariantsWithMeasurements(invariants, measurementArtifacts);
  const statusCounts = countByStatus(invariantsWithMeasurements.map(i => ({ status: i.status })));

  // Use service output URLs from artifacts (config was removed from ventures)
  const liveOutputUrl = primaryOutput?.url || null;
  const telegramUrl = null; // Telegram URL can be added via service outputs if needed

  return (
    <div className="flex flex-col h-full gap-6">
      <VentureDashboard
        liveOutputUrl={liveOutputUrl}
        telegramUrl={telegramUrl}
        activityData={activityData}
        workstreamId={id}
        ventureId={venture?.id}
        invariants={invariantsWithMeasurements}
        statusCounts={statusCounts}
        primaryOutput={primaryOutput}
        fetchActivity={fetchWorkstreamActivityAction}
        initialTab={initialTab}
        initialSelectedJobId={initialSelectedJobId}
        tokenInfo={venture ? {
          token_address: venture.token_address,
          token_symbol: venture.token_symbol,
          token_name: venture.token_name,
          token_launch_platform: venture.token_launch_platform,
          governance_address: venture.governance_address,
          pool_address: venture.pool_address,
          token_metadata: venture.token_metadata,
        } : undefined}
      />
    </div>
  );
}

export function VentureDetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-10 w-64 animate-pulse rounded bg-muted" />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[500px]">
        <div className="lg:col-span-2 bg-muted/20 animate-pulse rounded-xl" />
        <div className="lg:col-span-1 bg-muted/20 animate-pulse rounded-xl" />
      </div>
    </div>
  );
}

/**
 * Fallback view for ventures without a root workstream (e.g. schedule-only ventures).
 * Renders the dispatch schedule directly instead of the full workstream dashboard.
 */
async function VentureScheduleView({ ventureId }: { ventureId: string }) {
  const venture = await getVenture(ventureId);
  if (!venture) notFound();

  const workstreams = await getVentureWorkstreams(ventureId, 200).catch(() => []);

  return (
    <VentureScheduleDashboard
      ventureId={ventureId}
      schedule={venture.dispatch_schedule}
      workstreams={workstreams}
      ventureBlueprint={venture.blueprint}
    />
  );
}

export default async function VenturePage({ params }: VenturePageProps) {
  const { id } = await params;
  const instance = await getServiceInstance(id);

  // Fallback: if ID is a venture UUID (not a workstream), check Supabase
  if (!instance) {
    const venture = await getVenture(id);
    if (!venture) notFound();

    return (
      <div className="flex min-h-screen flex-col bg-background">
        <SiteHeader
          breadcrumbs={[
            { label: 'Explorer', href: '/' },
            { label: 'Ventures', href: '/ventures' },
            { label: venture.name }
          ]}
        />
        <main className="flex-1 py-6 flex flex-col min-h-0">
          <div className="flex-1 flex flex-col min-h-0 px-4">
            <Suspense fallback={<VentureDetailSkeleton />}>
              <VentureScheduleView ventureId={id} />
            </Suspense>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Ventures', href: '/ventures' },
          { label: instance.jobName }
        ]}
      />

      <main className="flex-1 py-6 flex flex-col min-h-0">
        <div className="flex-1 flex flex-col min-h-0 px-4">
          <Suspense fallback={<VentureDetailSkeleton />}>
            <VentureDetail id={id} />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
