'use server';

import { revalidatePath } from 'next/cache';
import { request as gqlRequest } from 'graphql-request';
import { supabaseMutate, supabaseAdminQuery } from '@/lib/supabase';
import { getWorkstreamActivity } from '@/lib/ventures/service-queries';
import type { JobDefinition } from '@/lib/subgraph';

interface CreateVentureInput {
  name: string;
  slug: string;
  owner_address: string;
  template: {
    sources: string[];
    lookbackPeriod: string;
    outputTopic: string;
    contentBrief: string;
    formatBrief: string;
    outputFormat: string;
    dispatchCron?: string;
    formatRules?: {
      minWords?: number;
      maxWords?: number;
      requiredSections?: string[];
      requiredCitations?: number;
    };
  };
}

const CONTENT_VENTURE_TEMPLATE_ID = '2942d6f6-2d03-4ae1-8189-5f78fd60cee3';
const CONTENT_TEMPLATE_SLUG = 'content-template';
const CONTENT_TEMPLATE_UUID = '26fcfe77-7281-4556-9a3d-7b05cf4f6b0b';

export async function createVenture(input: CreateVentureInput) {
  const dispatchCron = input.template.dispatchCron?.trim();
  const dispatchSchedule = dispatchCron ? [{
    id: crypto.randomUUID(),
    templateId: CONTENT_TEMPLATE_UUID,
    cron: dispatchCron,
    input: {
      name: input.name,
      sources: input.template.sources,
      lookbackPeriod: input.template.lookbackPeriod,
      outputTopic: input.template.outputTopic,
      contentBrief: input.template.contentBrief,
      formatBrief: input.template.formatBrief,
      outputFormat: input.template.outputFormat,
      ...(input.template.formatRules ? { formatRules: input.template.formatRules } : {}),
    },
    label: 'Content cadence',
    enabled: true,
  }] : [];

  // Deduplicate slug: check if it exists, append suffix if needed
  let slug = input.slug;
  const existing = await supabaseAdminQuery<{ id: string }>('ventures', {
    select: 'id',
    slug: `eq.${slug}`,
    limit: '1',
  });
  if (existing.length > 0) {
    slug = `${slug}-${Date.now().toString(36)}`;
  }

  const payload = {
    name: input.name,
    slug,
    description: `Content agent: ${input.template.contentBrief}`,
    owner_address: input.owner_address,
    status: 'proposed',
    creator_type: 'human',
    venture_template_id: CONTENT_VENTURE_TEMPLATE_ID,
    dispatch_schedule: dispatchSchedule,
    blueprint: {
      category: 'Content',
      templateId: CONTENT_TEMPLATE_SLUG,
      templateConfig: {
        name: input.name,
        sources: input.template.sources,
        lookbackPeriod: input.template.lookbackPeriod,
        outputTopic: input.template.outputTopic,
        contentBrief: input.template.contentBrief,
        formatBrief: input.template.formatBrief,
        outputFormat: input.template.outputFormat,
        ...(input.template.formatRules ? { formatRules: input.template.formatRules } : {}),
      },
    },
  };

  console.log('[createVenture] Creating venture:', slug);

  const result = await supabaseMutate<{ id: string; slug: string }>('ventures', 'POST', payload);

  if (result.error) {
    console.error('[createVenture] Failed:', result.error);
    return result;
  }

  if (!result.data?.id) {
    console.error('[createVenture] No data returned after insert');
    return { error: 'Venture creation failed — no data returned.' };
  }

  console.log('[createVenture] Success:', result.data.id, result.data.slug);
  revalidatePath('/');
  revalidatePath(`/ventures/${result.data.slug}`);

  return result;
}

interface UpdateVentureTokenInput {
  token_address: string;
  token_symbol: string;
  token_name: string;
  governance_address: string;
  pool_address: string;
  token_metadata: Record<string, unknown>;
}

export async function updateVentureToken(
  ventureId: string,
  input: UpdateVentureTokenInput
) {
  const result = await supabaseMutate<{ id: string }>('ventures', 'PATCH', {
    ...input,
    token_launch_platform: 'doppler',
    status: 'bonding',
  }, ventureId);

  if (result.data) {
    revalidatePath('/');
  }

  return result;
}

// Social Actions

export async function getLikeStatus(ventureId: string, userAddress: string) {
  const result = await supabaseAdminQuery('likes', {
    select: 'venture_id',
    venture_id: `eq.${ventureId}`,
    user_address: `eq.${userAddress}`,
    limit: '1'
  });
  return result.length > 0;
}

export async function toggleLike(ventureId: string, userAddress: string) {
  // Check if already liked
  const existing = await getLikeStatus(ventureId, userAddress);

  if (existing) {
    // Unlike
    return supabaseMutate('likes', 'DELETE', undefined, undefined, {
      venture_id: `eq.${ventureId}`,
      user_address: `eq.${userAddress}`
    });
  } else {
    // Like
    return supabaseMutate('likes', 'POST', {
      venture_id: ventureId,
      user_address: userAddress
    });
  }
}

export interface Comment {
  id: string;
  venture_id: string;
  user_address: string;
  content: string;
  created_at: string;
}

export async function getComments(ventureId: string) {
  return supabaseAdminQuery<Comment>('comments', {
    select: '*',
    venture_id: `eq.${ventureId}`,
    order: 'created_at.desc'
  });
}

export async function postComment(ventureId: string, userAddress: string, content: string) {
  return supabaseMutate<Comment>('comments', 'POST', {
    venture_id: ventureId,
    user_address: userAddress,
    content
  });
}

// Workstream Activity (for VentureDashboard polling)

export async function fetchWorkstreamActivityAction(workstreamId: string): Promise<{ jobDefinitions: JobDefinition[] }> {
    try {
        return await getWorkstreamActivity(workstreamId);
    } catch (error) {
        console.error('Failed to fetch activity:', error);
        return { jobDefinitions: [] };
    }
}

// Artifact queries (server-side — shared-ui's graphql-request can't resolve env vars in the client bundle)

import { queryRequests, queryArtifacts, getJobName, type Artifact } from '@jinn/shared-ui';

// Operational topics to exclude — internal system artifacts
const OPERATIONAL_TOPICS = [
  'situation',
  'measurement',
  'git_branch',
  'git/branch',
  'service_output',
  'memory',
  'venture_ooda_situation',
  'debug',
  'heartbeat',
  'heartbeat-check',
];

export interface ArtifactWithJobName extends Artifact {
  jobName?: string;
}

function isOperationalTopic(topic: string): boolean {
  const normalized = topic.toLowerCase();
  return (
    OPERATIONAL_TOPICS.includes(normalized) ||
    normalized.startsWith('heartbeat') ||
    normalized.startsWith('debug')
  );
}

function isStructuredOutputArtifact(
  artifact: Pick<Artifact, 'name' | 'topic' | 'contentPreview'>
): boolean {
  const name = artifact.name.toLowerCase();
  const topic = artifact.topic.toLowerCase();
  const preview = (artifact.contentPreview || '').trim().toLowerCase();

  if (name.includes('structured output') || name.includes('(structured)')) {
    return true;
  }
  if (topic.includes('structured output')) {
    return true;
  }

  // Many machine-form structured outputs currently expose a JSON wrapper with contentBody.
  if (preview.startsWith('{') && /"contentbody"\s*:/.test(preview)) {
    return true;
  }

  return false;
}

function sortArtifactsNewestFirst(artifacts: Artifact[]): Artifact[] {
  return [...artifacts].sort((a, b) => Number(b.blockTimestamp || 0) - Number(a.blockTimestamp || 0));
}

async function attachJobNames(artifacts: Artifact[]): Promise<ArtifactWithJobName[]> {
  const jobDefIds = [...new Set(
    artifacts
      .map(a => a.sourceJobDefinitionId)
      .filter((id): id is string => !!id)
  )];

  const jobNameMap = new Map<string, string>();
  const nameResults = await Promise.all(
    jobDefIds.map(async id => {
      const name = await getJobName(id).catch(() => null);
      return [id, name] as const;
    })
  );
  for (const [id, name] of nameResults) {
    if (name) jobNameMap.set(id, name);
  }

  return artifacts.map(artifact => ({
    ...artifact,
    jobName: artifact.sourceJobDefinitionId
      ? jobNameMap.get(artifact.sourceJobDefinitionId) || undefined
      : undefined,
  }));
}

export async function fetchWorkstreamArtifactsAction(workstreamId: string): Promise<ArtifactWithJobName[]> {
  try {
    const requestsResponse = await queryRequests({ where: { workstreamId }, limit: 200 });
    const requestIds = [workstreamId, ...requestsResponse.items.map((r: { id: string }) => r.id)];

    // Fetch artifacts for all requests in parallel (batches of 20 to avoid overwhelming Ponder)
    const BATCH_SIZE = 20;
    const allArtifacts: Artifact[] = [];
    for (let i = 0; i < requestIds.length; i += BATCH_SIZE) {
      const batch = requestIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(requestId =>
          queryArtifacts({
            where: { requestId },
            orderBy: 'blockTimestamp',
            orderDirection: 'desc',
            limit: 50,
          }).catch(() => ({ items: [] as Artifact[] }))
        )
      );
      for (const r of results) allArtifacts.push(...r.items);
    }

    const contentArtifacts = sortArtifactsNewestFirst(
      allArtifacts.filter((a) => !isOperationalTopic(a.topic))
    );

    return attachJobNames(contentArtifacts);
  } catch (error) {
    console.error('Failed to fetch workstream artifacts:', error);
    return [];
  }
}

export async function fetchWorkstreamRootArtifactsAction(workstreamId: string): Promise<ArtifactWithJobName[]> {
  try {
    const response = await queryArtifacts({
      where: { requestId: workstreamId },
      orderBy: 'blockTimestamp',
      orderDirection: 'desc',
      limit: 200,
    });

    const contentArtifacts = sortArtifactsNewestFirst(
      response.items.filter((artifact) => !isOperationalTopic(artifact.topic))
    );

    return attachJobNames(contentArtifacts);
  } catch (error) {
    console.error('Failed to fetch root workstream artifacts:', error);
    return [];
  }
}

export interface StreamFeedItem extends ArtifactWithJobName {
  ventureName?: string;
  ventureSlug?: string;
}

const STREAM_ALLOWED_VENTURE_OR_TEMPLATE_ID = '2942d6f6-2d03-4ae1-8189-5f78fd60cee3';

interface StreamFeedArtifact extends Artifact {
  ventureId?: string | null;
  workstreamId?: string | null;
  documentType?: string | null;
  contentCid?: string | null;
  type?: string | null;
}

const STREAM_FEED_ARTIFACTS_QUERY = `
  query StreamFeedArtifacts($limit: Int!) {
    artifacts(
      limit: $limit
      orderBy: "blockTimestamp"
      orderDirection: "desc"
      where: { ventureId_not: null, type: "TEMPLATE_OUTPUT" }
    ) {
      items {
        id
        requestId
        sourceRequestId
        sourceJobDefinitionId
        ventureId
        workstreamId
        name
        cid
        contentCid
        topic
        contentPreview
        blockTimestamp
        documentType
        type
      }
    }
  }
`;

const DEFAULT_SUBGRAPH_URL = 'https://indexer.jinn.network/graphql';
const ARTIFACT_BY_CID_QUERY = `
  query ArtifactByCid($cid: String!) {
    artifacts(where: { cid: $cid }, limit: 1) {
      items {
        id
        requestId
        sourceRequestId
        sourceJobDefinitionId
        workstreamId
        name
        cid
        contentCid
        topic
        contentPreview
        blockTimestamp
        documentType
      }
    }
  }
`;

async function fetchStreamFeedArtifacts(limit: number): Promise<StreamFeedArtifact[]> {
  const configuredUrl = process.env.NEXT_PUBLIC_SUBGRAPH_URL;
  const candidateUrls = [...new Set([configuredUrl, DEFAULT_SUBGRAPH_URL].filter(Boolean) as string[])];

  for (const subgraphUrl of candidateUrls) {
    try {
      const response = await gqlRequest<{ artifacts: { items: StreamFeedArtifact[] } }>(
        subgraphUrl,
        STREAM_FEED_ARTIFACTS_QUERY,
        { limit }
      );
      if (response.artifacts.items.length > 0) {
        return response.artifacts.items;
      }
    } catch (error) {
      console.error(`[streams] Failed feed query against ${subgraphUrl}:`, error);
    }
  }

  // Fallback: still return recent artifacts even if extended schema fields are unavailable.
  const fallback = await queryArtifacts({
    orderBy: 'blockTimestamp',
    orderDirection: 'desc',
    limit,
  });
  return fallback.items.map((artifact) => ({
    ...artifact,
    ventureId: null,
    workstreamId: null,
  }));
}

export async function fetchStreamFeedAction(): Promise<StreamFeedItem[]> {
  try {
    let ventureById = new Map<string, { name: string; slug: string; ventureTemplateId: string | null }>();
    try {
      const { getVentures } = await import('@/lib/ventures');
      const ventures = await getVentures(500);
      ventureById = new Map(
        ventures.map((venture) => [
          venture.id,
          {
            name: venture.name,
            slug: venture.slug,
            ventureTemplateId: venture.venture_template_id,
          },
        ] as const)
      );
    } catch (error) {
      console.error('[streams] Failed to load ventures; continuing without venture name mapping:', error);
    }

    const artifacts = await fetchStreamFeedArtifacts(200);

    // Query already filters for type=TEMPLATE_OUTPUT and ventureId_not=null.
    // Just apply the venture template filter.
    const filtered = artifacts.filter((artifact) => {
      if (!artifact.ventureId) return false;
      if (artifact.ventureId === STREAM_ALLOWED_VENTURE_OR_TEMPLATE_ID) return true;

      const venture = ventureById.get(artifact.ventureId);
      return venture?.ventureTemplateId === STREAM_ALLOWED_VENTURE_OR_TEMPLATE_ID;
    });

    const dedupedSorted = [...new Map(
      filtered
        .map((artifact) => {
          const venture = artifact.ventureId ? ventureById.get(artifact.ventureId) : undefined;
          return [artifact.id, {
            ...artifact,
            ventureName: venture?.name,
            ventureSlug: venture?.slug,
          } satisfies StreamFeedItem] as const;
        })
    ).values()]
      .sort((a, b) => Number(b.blockTimestamp || 0) - Number(a.blockTimestamp || 0))
      .slice(0, 150);

    const ventureMetaByArtifactId = new Map(
      dedupedSorted.map((artifact) => [
        artifact.id,
        {
          ventureName: artifact.ventureName,
          ventureSlug: artifact.ventureSlug,
        },
      ])
    );

    const withJobNames = await attachJobNames(dedupedSorted as Artifact[]);
    return withJobNames.map((artifact) => {
      const ventureMeta = ventureMetaByArtifactId.get(artifact.id);
      return {
        ...artifact,
        ventureName: ventureMeta?.ventureName,
        ventureSlug: ventureMeta?.ventureSlug,
      };
    });
  } catch (error) {
    console.error('Failed to fetch stream feed:', error);
    return [];
  }
}

export async function fetchArtifactByCidAction(cid: string): Promise<ArtifactWithJobName | null> {
  const configuredUrl = process.env.NEXT_PUBLIC_SUBGRAPH_URL;
  const candidateUrls = [...new Set([configuredUrl, DEFAULT_SUBGRAPH_URL].filter(Boolean) as string[])];

  for (const subgraphUrl of candidateUrls) {
    try {
      const response = await gqlRequest<{ artifacts: { items: Artifact[] } }>(
        subgraphUrl,
        ARTIFACT_BY_CID_QUERY,
        { cid }
      );
      const artifact = response.artifacts.items[0];
      if (!artifact) continue;

      const jobName = artifact.sourceJobDefinitionId
        ? await getJobName(artifact.sourceJobDefinitionId).catch(() => null)
        : null;

      return { ...artifact, jobName: jobName || undefined };
    } catch (error) {
      console.error(`[streams] Failed artifact-by-cid query against ${subgraphUrl}:`, error);
    }
  }

  try {
    const result = await queryArtifacts({ where: { cid }, limit: 1 });
    const artifact = result.items[0];
    if (!artifact) return null;
    const jobName = artifact.sourceJobDefinitionId
      ? await getJobName(artifact.sourceJobDefinitionId).catch(() => null)
      : null;
    return { ...artifact, jobName: jobName || undefined };
  } catch {
    return null;
  }
}

export async function fetchWorkstreamRootArtifactByCidAction(
  workstreamId: string,
  cid: string
): Promise<ArtifactWithJobName | null> {
  try {
    const result = await queryArtifacts({
      where: { cid, requestId: workstreamId },
      limit: 1,
    });
    const artifact = result.items[0];
    if (!artifact || isOperationalTopic(artifact.topic)) return null;

    const jobName = artifact.sourceJobDefinitionId
      ? await getJobName(artifact.sourceJobDefinitionId).catch(() => null)
      : null;

    return { ...artifact, jobName: jobName || undefined };
  } catch {
    return null;
  }
}

async function fetchIpfsText(cid: string): Promise<string | null> {
  const gateways = ['https://gateway.autonolas.tech/ipfs/', 'https://ipfs.io/ipfs/'];
  for (const gateway of gateways) {
    try {
      const response = await fetch(`${gateway}${cid}`, {
        signal: AbortSignal.timeout(10000),
        cache: 'no-store',
      });
      if (!response.ok) continue;
      return await response.text();
    } catch {
      continue;
    }
  }
  return null;
}

function isRegistrationJson(parsed: Record<string, unknown>): boolean {
  return (
    typeof parsed.documentType === 'string' &&
    (parsed.documentType as string).startsWith('adw:')
  );
}

export async function fetchArtifactContentAction(
  cid: string,
): Promise<{ content: string; contentType: string } | null> {
  const text = await fetchIpfsText(cid);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);

    // If this is a registration wrapper, follow through to the actual content.
    if (isRegistrationJson(parsed)) {
      // Try storage URI first (e.g. ipfs://Qm...)
      const storageUri = parsed.storage?.[0]?.uri as string | undefined;
      const contentCid = storageUri?.startsWith('ipfs://')
        ? storageUri.slice('ipfs://'.length)
        : (parsed.contentHash as string | undefined);

      if (contentCid) {
        const innerText = await fetchIpfsText(contentCid);
        if (innerText) {
          try {
            const innerParsed = JSON.parse(innerText);
            const content = innerParsed.content || innerText;
            return {
              content: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
              contentType: 'application/json',
            };
          } catch {
            return { content: innerText, contentType: 'text/plain' };
          }
        }
      }
    }

    // Standard artifact format — extract .content field
    const content = parsed.content || text;
    return {
      content: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      contentType: 'application/json',
    };
  } catch {
    return { content: text, contentType: 'text/plain' };
  }
}

// KPI Management

export interface KPIInvariant {
  id: string;
  type: 'FLOOR' | 'CEILING' | 'RANGE' | 'BOOLEAN';
  metric?: string;
  condition?: string;
  min?: number;
  max?: number;
  assessment: string;
}

export async function updateVentureKPIs(
  ventureId: string,
  invariants: KPIInvariant[],
  userAddress: string
) {
  // Verify ownership
  const ventures = await supabaseAdminQuery<{ id: string; owner_address: string; blueprint: Record<string, unknown> | null }>(
    'ventures',
    {
      select: 'id,owner_address,blueprint',
      id: `eq.${ventureId}`,
      limit: '1',
    }
  );

  const venture = ventures[0];
  if (!venture) return { error: 'Venture not found' };
  if (venture.owner_address.toLowerCase() !== userAddress.toLowerCase()) {
    return { error: 'Only the venture owner can update KPIs' };
  }

  const existingBlueprint = (venture.blueprint || {}) as Record<string, unknown>;
  const result = await supabaseMutate('ventures', 'PATCH', {
    blueprint: {
      ...existingBlueprint,
      invariants,
    },
  }, ventureId);

  if (!result.error) {
    revalidatePath('/');
    revalidatePath(`/ventures/`);
  }

  return result;
}
