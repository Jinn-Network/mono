import { z } from 'zod';
import {
  ContributionCandidateV1Schema,
  EpisodeV1WriteSchema,
  JINN_PLUGIN_CONTRACT_VERSION,
  PickupConfigSchema,
  SessionActivityFactsWriteSchema,
  type FirstTurnPickupResult,
  type ContributionLedgerEntry,
  type JinnPluginDeps,
  type SessionEndResult,
} from '@jinn-network/plugin';

export const PROCESS_CONTRACT_VERSION = JINN_PLUGIN_CONTRACT_VERSION;
export const PROCESS_STATUSES = ['ok', 'degraded', 'unavailable'] as const;
export type ProcessStatus = (typeof PROCESS_STATUSES)[number];

export interface ProcessEnvelope<T> {
  contractVersion: typeof PROCESS_CONTRACT_VERSION;
  status: ProcessStatus;
  value?: T;
  reason?: string;
}

const SessionMetaSchema = z.strictObject({
  sessionId: z.string().min(1).max(128),
  taskSummary: z.string().min(1),
  distributionTags: z.array(z.string().min(1)).optional(),
  harness: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  model: z.string().min(1),
  tools: z.array(z.string().min(1)),
  skillsLoadout: z.array(z.string().min(1)).optional(),
  pickup: PickupConfigSchema.optional(),
  /** Fed into `deriveSearchTerms`'s repo-slug bonus (rescope §3.3). Additive — absent is fine. */
  repositorySlug: z.string().min(1).optional(),
  kind: z.enum(['user', 'host-internal']).optional(),
  parentSessionId: z.string().min(1).max(128).optional(),
});

export const SessionPickupRequestV1Schema = z.strictObject({
  contractVersion: z.literal(PROCESS_CONTRACT_VERSION),
  meta: SessionMetaSchema,
  firstMessage: z.string(),
});

export const SessionEndRequestV1Schema = z.strictObject({
  contractVersion: z.literal(PROCESS_CONTRACT_VERSION),
  episode: EpisodeV1WriteSchema,
  activity: SessionActivityFactsWriteSchema,
  eligibilityInputs: z.strictObject({
    publicRepo: z.boolean().optional(),
    acceptedDiff: z.boolean().optional(),
  }),
  contributionCandidate: ContributionCandidateV1Schema.optional(),
  contributionVetoed: z.boolean().optional(),
});

export type SessionPickupRequestV1 = z.infer<typeof SessionPickupRequestV1Schema>;
export type SessionEndRequestV1 = z.infer<typeof SessionEndRequestV1Schema>;

export function envelope<T>(status: ProcessStatus, value?: T, reason?: string): ProcessEnvelope<T> {
  return {
    contractVersion: PROCESS_CONTRACT_VERSION,
    status,
    ...(value !== undefined ? { value } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

export function sessionEndEnvelope(result: SessionEndResult): ProcessEnvelope<SessionEndResult> {
  if (result.persistence.status === 'unavailable') {
    return envelope('unavailable', result, result.persistence.reason);
  }
  const reasons: string[] = [];
  if (result.persistence.status === 'degraded') reasons.push(result.persistence.reason);
  if (result.contribution?.status === 'degraded' || result.contribution?.status === 'unavailable') {
    reasons.push(result.contribution.reason);
  }
  return envelope(reasons.length > 0 ? 'degraded' : 'ok', result, reasons[0]);
}

/** Track pickup port health without repeating requests merely to classify output. */
export function trackingCorpus(deps: JinnPluginDeps): {
  deps: JinnPluginDeps;
  status: () => ProcessStatus;
  reason: () => string | undefined;
} {
  let status: ProcessStatus = 'ok';
  let reason: string | undefined;
  const observe = <T extends { status: ProcessStatus; reason?: string }>(result: T): T => {
    if (result.status === 'unavailable' || (result.status === 'degraded' && status === 'ok')) {
      status = result.status;
      reason = result.reason;
    }
    return result;
  };
  return {
    deps: {
      ...deps,
      corpus: {
        async search(query) { return observe(await deps.corpus.search(query)); },
        async get(ref) { return observe(await deps.corpus.get(ref)); },
      },
      skills: {
        async install(ref) { return observe(await deps.skills.install(ref)); },
        async list() { return observe(await deps.skills.list()); },
        async uninstall(ref) { return observe(await deps.skills.uninstall(ref)); },
      },
    },
    status: () => status,
    reason: () => reason,
  };
}

export type SessionPickupEnvelope = ProcessEnvelope<FirstTurnPickupResult>;

export interface ContributionLedgerRowV1 {
  time: string;
  task: string;
  env: string | null;
  anchor: string | null;
  tier: 'user-accepted' | 'tests-passed';
  state: ContributionLedgerEntry['status'];
}

function displayTimestamp(value: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u.exec(value);
  return match ? `${match[1]}-${match[2]} ${match[3]}:${match[4]}` : value;
}

/** Persistence-safe terminal projection. Local IDs and candidate evidence do not cross it. */
export function contributionLedgerRow(entry: ContributionLedgerEntry): ContributionLedgerRowV1 {
  const published = entry.status === 'published';
  const repository = entry.repositorySlug ?? 'repository unavailable';
  const commit = entry.baseCommit ? entry.baseCommit.slice(0, 8) : 'commit unavailable';
  return {
    time: displayTimestamp(entry.createdAt),
    task: `${repository} @ ${commit}`,
    env: published ? entry.mintRef ?? null : null,
    anchor: published ? entry.publicationRef ?? null : null,
    tier: entry.verifiabilityTier,
    state: entry.status,
  };
}
