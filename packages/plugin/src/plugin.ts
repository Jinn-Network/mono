/**
 * Host-neutral Stage 1 product workflow. Embedded hosts buffer their session
 * through `PluginSession`; process hosts pass the already-captured EpisodeV1
 * to `completeSession`. Both paths persist the same canonical evidence and
 * contribution contracts.
 */

/// <reference types="node" />
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  ContributionLedgerEntry,
  ContributionPort,
  ContributionStatusSnapshot,
} from './ports/contribution-port.js';
import type { CorpusPort, CorpusRecord } from './ports/corpus-port.js';
import type { EvidencePort } from './ports/evidence-port.js';
import type { LocalLearningPort } from './ports/local-learning-port.js';
import type { SkillsPort } from './ports/skills-port.js';
import type { EligibilityVerdict } from './schemas/eligibility-verdict.js';
import {
  EPISODE_SCHEMA_VERSION,
  EpisodeV1Schema,
  EpisodeV1WriteSchema,
  SessionActivityFactsSchema,
  SessionActivityFactsWriteSchema,
} from './schemas/episode.js';
import type { EpisodeV1, SessionActivityFacts } from './schemas/episode.js';
import {
  ContributionCandidateV1ProjectionSchema,
  ContributionCandidateV1Schema,
  type ContributionCandidateV1,
} from './schemas/contribution-candidate.js';
import type { KnowledgeHit } from './schemas/knowledge-hit.js';
import type { SessionSummary } from './schemas/session-summary.js';
import { projectKnowledgePacket, type KnowledgePacket } from './schemas/knowledge-packet.js';
import {
  deriveSearchTerms,
  discriminatingTerms,
  rankKnowledgeCandidates,
  rankScoredKnowledgeHits,
  scoreKnowledgeRecord,
  MAX_CONTENT_RESCORE_CANDIDATES,
  MAX_SELECTED_PACKETS,
  RELEVANCE_FLOOR,
} from './pickup.js';
import { degraded, ok, unavailable, valueOr, type PortResult } from './outcome.js';
import { parsePickupConfig, type PickupConfig } from './schemas/pickup-config.js';
import { deriveEligibility } from './eligibility.js';
import { foldExplain, foldHistory, type HistoryResult, type SessionExplanation } from './history.js';

export interface JinnPluginDeps {
  corpus: CorpusPort;
  evidence: EvidencePort;
  contribution: ContributionPort;
  localLearning: LocalLearningPort;
  skills: SkillsPort;
}

export interface SessionMeta {
  sessionId: string;
  taskSummary: string;
  distributionTags?: string[];
  harness: { name: string; version: string };
  model: string;
  tools: string[];
  skillsLoadout?: string[];
  pickup?: PickupConfig;
  /** Known at session start (e.g. `session_bridge.snapshot_repository`) —
   *  fed into `deriveSearchTerms`, which derives the repository's name (not
   *  its full slug) as a normal search term (#1790). */
  repositorySlug?: string;
  kind?: 'user' | 'host-internal';
  parentSessionId?: string;
}

export interface FirstTurnPickupResult {
  contextBlock: string | null;
  packets: KnowledgePacket[];
  searchedTerms: string[];
  retrievalFired: boolean;
  eligibleRefs: string[];
  deliveredRefs: string[];
  deliveredCanonicalEpisodeIds: string[];
  deliveryMode: 'delivered' | 'disabled' | 'degraded' | 'withheld';
  deliveredContentHash?: string;
  degraded?: string;
}

export interface FirstTurnPickupOptions {
  excludeCanonicalEpisodeIds?: readonly string[];
}

export interface ToolCallEvent {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, unknown>;
  redactedKeys?: string[];
}

export interface SessionOutcome {
  status: 'completed' | 'failed' | 'abandoned';
  verifiabilityTier: 'user-accepted' | 'tests-passed' | 'evaluator-verified';
  summary?: string;
  durationMs: number;
  tokens?: { input: number; output: number };
  retentionPolicy: 'local-private' | 'contribution-eligible';
  publicRepo?: boolean;
  acceptedDiff?: boolean;
  testRuns?: { passed: number; failed: number };
}

export interface SessionEndResult {
  /**
   * Locally-generated episode id. This is a local reference, NOT proof of
   * persistence — branch on `persistence.status` to know whether the episode
   * was durably stored.
   */
  episodeRef: string;
  /** Honest surfacing of the `evidence.put()` outcome (#1696 AC2). */
  persistence: PortResult<{ episodeId: string }>;
  /** Present iff a candidate was supplied; independent from persistence. */
  contribution?: PortResult<ContributionCompletionReceipt>;
  eligibility: EligibilityVerdict;
  summary: SessionSummary;
}

export type ContributionCompletionReceipt =
  { recordId: string } & Partial<ContributionStatusSnapshot>;

export interface ContributionPreview {
  recordId: string;
  repositorySlug: string;
  baseCommit: string;
  localState: 'recorded' | 'minted' | 'rejected';
  publicationState: 'preview-required' | 'queued';
  status: 'preview-required' | 'queued';
  acknowledged: boolean;
}

async function previewContribution(
  deps: JinnPluginDeps,
  acknowledge: boolean,
): Promise<PortResult<ContributionPreview | null>> {
  let ledger;
  try {
    ledger = await deps.contribution.ledger();
  } catch (error) {
    return unavailable(`contribution preview failed: ${errorReason(error)}`);
  }
  if (ledger.status === 'unavailable') return unavailable(ledger.reason);
  const rows = ledger.status === 'ok' ? ledger.value : ledger.value ?? [];
  const row = rows.find((entry) => entry.publicationState === 'preview-required');
  if (!row) {
    return ledger.status === 'degraded' ? degraded(ledger.reason, null) : ok(null);
  }
  if (!row.repositorySlug || !row.baseCommit) {
    return unavailable('contribution preview repository facts unavailable');
  }

  let publicationState: 'preview-required' | 'queued' = 'preview-required';
  if (acknowledge) {
    let authorization;
    try {
      authorization = await deps.contribution.authorize(row.recordId);
    } catch (error) {
      return unavailable(`contribution preview acknowledgement failed: ${errorReason(error)}`);
    }
    if (authorization.status === 'unavailable') return unavailable(authorization.reason);
    if (authorization.status === 'degraded') {
      return degraded(authorization.reason);
    }
    publicationState = 'queued';
  }

  const value: ContributionPreview = {
    recordId: row.recordId,
    repositorySlug: row.repositorySlug,
    baseCommit: row.baseCommit,
    localState: row.localState,
    publicationState,
    status: publicationState,
    acknowledged: acknowledge,
  };
  return ledger.status === 'degraded' ? degraded(ledger.reason, value) : ok(value);
}

export const JINN_PLUGIN_CONTRACT_VERSION = 1 as const;

export interface CompleteSessionEligibilityInputs {
  publicRepo?: boolean;
  acceptedDiff?: boolean;
}

export interface CompleteSessionInput {
  contractVersion: typeof JINN_PLUGIN_CONTRACT_VERSION;
  episode: EpisodeV1;
  activity: SessionActivityFacts;
  eligibilityInputs: CompleteSessionEligibilityInputs;
  contributionCandidate?: ContributionCandidateV1;
  /** Per-task publication veto; defaults to false. The candidate is still recorded locally. */
  contributionVetoed?: boolean;
}

interface CompletionSummaryHits {
  /** The packets actually provided to the agent this session, when the
   *  caller drove pickup through `PluginSession` (embedded-host path). Absent
   *  (defaults to `[]`) for process-delegated `session end` calls, which
   *  never round-trip packets through this in-process value. */
  providedPackets: KnowledgePacket[];
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Titles for `SessionSummary.providedPackets` — the packet's own task summary. */
function packetTitle(packet: KnowledgePacket): { ref: string; title: string } {
  return { ref: packet.ref, title: packet.task.summary };
}

async function completeSession(
  deps: JinnPluginDeps,
  input: CompleteSessionInput,
  hits: CompletionSummaryHits = { providedPackets: [] },
): Promise<SessionEndResult> {
  if (input.contractVersion !== JINN_PLUGIN_CONTRACT_VERSION) {
    throw new Error(`unsupported plugin contract version: ${String(input.contractVersion)}`);
  }

  const capturedEpisode = EpisodeV1Schema.parse(input.episode);
  const activity = SessionActivityFactsSchema.parse(input.activity);
  const eligibility = deriveEligibility(
    {
      status: capturedEpisode.outcome.status,
      verifiabilityTier: capturedEpisode.outcome.verificationStrength,
      retentionPolicy: capturedEpisode.retention.policy,
      publicRepo: input.eligibilityInputs.publicRepo,
      acceptedDiff: input.eligibilityInputs.acceptedDiff,
    },
    capturedEpisode.session.capturedAt,
  );
  const embeddedCandidateResult = capturedEpisode.contributionCandidate === undefined
    ? undefined
    : ContributionCandidateV1ProjectionSchema.safeParse(capturedEpisode.contributionCandidate);
  const requestCandidateResult = input.contributionCandidate === undefined
    ? undefined
    : ContributionCandidateV1Schema.safeParse(input.contributionCandidate);
  let resolvedCandidate: ContributionCandidateV1 | undefined;
  let contributionUnavailableReason: string | undefined;
  if (
    (capturedEpisode.contributionCandidate !== undefined || input.contributionCandidate !== undefined)
    && capturedEpisode.session.kind === 'host-internal'
  ) {
    contributionUnavailableReason = 'host-internal sessions cannot create contribution candidates';
  } else if (embeddedCandidateResult && !embeddedCandidateResult.success) {
    contributionUnavailableReason = 'invalid embedded contribution candidate';
  } else if (requestCandidateResult && !requestCandidateResult.success) {
    contributionUnavailableReason = 'invalid contribution candidate';
  } else {
    const embeddedCandidate = embeddedCandidateResult?.data;
    const requestCandidate = requestCandidateResult?.data;
    if (
      embeddedCandidate
      && requestCandidate
      && !isDeepStrictEqual(embeddedCandidate, requestCandidate)
    ) {
      contributionUnavailableReason = 'embedded and request contribution candidates must match';
    } else {
      resolvedCandidate = requestCandidate ?? embeddedCandidate;
      if (resolvedCandidate && resolvedCandidate.sourceId !== capturedEpisode.episodeId) {
        contributionUnavailableReason = 'contribution candidate sourceId must match episodeId';
        resolvedCandidate = undefined;
      }
    }
  }

  // A contribution payload must be present before the first immutable evidence
  // write. Invalid or forbidden payloads are dropped so the session evidence
  // itself is still retained.
  const { contributionCandidate: _capturedCandidate, ...capturedWithoutCandidate } = capturedEpisode;
  const episode = EpisodeV1WriteSchema.parse({
    ...capturedWithoutCandidate,
    session: {
      ...capturedEpisode.session,
      kind: capturedEpisode.session.kind ?? 'user',
    },
    origin: capturedEpisode.origin === 'legacy-unstamped'
      ? {
          writer: capturedEpisode.environment.harness.name,
          build: capturedEpisode.environment.harness.version,
        }
      : capturedEpisode.origin,
    activity,
    eligibility,
    ...(resolvedCandidate ? { contributionCandidate: resolvedCandidate } : {}),
  });

  let persistence: PortResult<{ episodeId: string }>;
  try {
    persistence = await deps.evidence.put(episode);
  } catch (error) {
    persistence = unavailable(`evidence put failed: ${errorReason(error)}`);
  }

  let contribution: PortResult<ContributionCompletionReceipt> | undefined;
  if (contributionUnavailableReason) {
    contribution = unavailable(contributionUnavailableReason);
  } else if (resolvedCandidate !== undefined) {
    const persistedEpisodeId = persistence.status === 'unavailable'
      ? undefined
      : persistence.value?.episodeId;
    if (persistedEpisodeId !== episode.episodeId) {
      contribution = unavailable(
        'contribution reference not recorded because canonical episode persistence was not confirmed',
      );
    } else {
      try {
        contribution = await deps.contribution.recordMineable(
          resolvedCandidate,
          input.contributionVetoed ? { publicationState: 'vetoed' } : undefined,
        );
      } catch (error) {
        contribution = unavailable(`contribution record failed: ${errorReason(error)}`);
      }
      if (contribution.status === 'ok' && input.contributionVetoed === true) {
        const recordId = contribution.value.recordId;
        try {
          const veto = await deps.contribution.veto(recordId);
          contribution = veto.status === 'unavailable'
            ? degraded(veto.reason, { recordId })
            : veto;
        } catch (error) {
          contribution = degraded(
            `contribution veto failed: ${errorReason(error)}`,
            { recordId },
          );
        }
      } else if (contribution.status === 'ok') {
        const recordId = contribution.value.recordId;
        try {
          const snapshot = await deps.contribution.mintStatus(recordId);
          if (snapshot.status === 'ok') {
            contribution = ok({ recordId, ...snapshot.value });
          } else if (snapshot.status === 'degraded' && snapshot.value !== undefined) {
            contribution = degraded(snapshot.reason, { recordId, ...snapshot.value });
          } else {
            contribution = degraded(snapshot.reason, { recordId });
          }
        } catch (error) {
          contribution = degraded(
            `contribution status failed: ${errorReason(error)}`,
            { recordId },
          );
        }
      }
    }
  }

  const providedPackets = hits.providedPackets.length > 0
    ? hits.providedPackets.map(packetTitle)
    : activity.providedRefs.map((ref) => ({ ref, title: ref }));

  const summary: SessionSummary = {
    episodeRef: episode.episodeId,
    searchedTerms: activity.searchedTerms,
    providedPackets,
    eligibility,
    nothingFound: activity.providedRefs.length === 0,
  };

  return {
    episodeRef: episode.episodeId,
    persistence,
    ...(contribution !== undefined ? { contribution } : {}),
    eligibility,
    summary,
  };
}

export class PluginSession {
  private readonly trajectory: EpisodeV1['trajectory'] = [];
  private searchedTerms: string[] = [];
  private providedRefs: string[] = [];
  private fetchedRefs: string[] = [];
  private packets: KnowledgePacket[] = [];
  private retrievalFired = false;
  private eligibleRefs: string[] = [];
  private deliveryMode: FirstTurnPickupResult['deliveryMode'] = 'disabled';
  private deliveredContentHash: string | undefined;
  private readonly capturedAt = new Date().toISOString();

  constructor(
    private readonly deps: JinnPluginDeps,
    private readonly meta: SessionMeta,
  ) {}

  async firstTurnPickup(
    firstMessage: string,
    options: FirstTurnPickupOptions = {},
  ): Promise<FirstTurnPickupResult> {
    const excludedCanonicalEpisodeIds = new Set(
      options.excludeCanonicalEpisodeIds ?? [],
    );
    const config = parsePickupConfig(this.meta.pickup);
    if (!config.enabled) {
      return {
        contextBlock: null,
        packets: [],
        searchedTerms: [],
        retrievalFired: false,
        eligibleRefs: [],
        deliveredRefs: [],
        deliveredCanonicalEpisodeIds: [],
        deliveryMode: 'disabled',
      };
    }

    const terms = deriveSearchTerms(firstMessage, this.meta.repositorySlug);
    // Search with every term; score with the discriminating ones only — the
    // repository name tags every record in an in-repo corpus, so counting it
    // halved the effective relevance floor (#1886).
    const scoringTerms = discriminatingTerms(terms, this.meta.repositorySlug);
    this.searchedTerms = terms;
    this.retrievalFired = true;
    this.deliveryMode = 'delivered';
    if (terms.length === 0) {
      this.deliveryMode = 'withheld';
      return {
        contextBlock: null,
        packets: [],
        searchedTerms: terms,
        retrievalFired: true,
        eligibleRefs: [],
        deliveredRefs: [],
        deliveredCanonicalEpisodeIds: [],
        deliveryMode: this.deliveryMode,
      };
    }

    // Issue all per-term searches concurrently — the searches are
    // independent (mono #1795: sequential awaits serialized ~1.6s/term of
    // live indexer round-trips, blowing the 15s host deadline once lexical
    // v2 widened the term budget to 10). `Promise.all` preserves result
    // order by term index regardless of resolution order, so the merge
    // below stays in term order — dedup priority and the first-observed
    // degraded reason are byte-identical to the old sequential loop. A
    // rejected promise would violate the PortResult convention (ports
    // resolve, never throw), but is guarded anyway: it degrades that one
    // term's contribution rather than the whole pickup (fail-open).
    const results = await Promise.all(
      terms.map((term) =>
        this.deps.corpus.search(term).catch((error: unknown) =>
          degraded<KnowledgeHit[]>(`corpus search rejected: ${errorReason(error)}`),
        ),
      ),
    );

    // Merge hits in term order (skip non-ok reads → fail open; keep the
    // first degraded reason observed for an honest, non-crashing report).
    let degradedReason: string | undefined;
    const byRef = new Map<string, KnowledgeHit>();
    for (const result of results) {
      if (result.status !== 'ok' && degradedReason === undefined) degradedReason = result.reason;
      for (const hit of valueOr(result, [] as KnowledgeHit[])) {
        if (!byRef.has(hit.ref)) byRef.set(hit.ref, hit);
      }
    }

    // Only the production local search adapter exposes this hit-level hint in
    // this release. Federated search is stable local-then-public, so the first
    // hit for an identity is the deterministic local form to prefer once a
    // fetched public record reveals that same identity.
    const preferredHitByCanonicalEpisodeId = new Map<string, KnowledgeHit>();
    for (const hit of byRef.values()) {
      if (
        hit.canonicalEpisodeId !== undefined
        && !preferredHitByCanonicalEpisodeId.has(hit.canonicalEpisodeId)
      ) {
        preferredHitByCanonicalEpisodeId.set(hit.canonicalEpisodeId, hit);
      }
    }

    const candidates = rankKnowledgeCandidates(
      [...byRef.values()].filter((hit) =>
        hit.canonicalEpisodeId === undefined
        || !excludedCanonicalEpisodeIds.has(hit.canonicalEpisodeId)),
      scoringTerms,
    );
    if (candidates.length === 0) {
      this.deliveryMode = degradedReason === undefined ? 'withheld' : 'degraded';
      return {
        contextBlock: null,
        packets: [],
        searchedTerms: terms,
        retrievalFired: true,
        eligibleRefs: [],
        deliveredRefs: [],
        deliveredCanonicalEpisodeIds: [],
        deliveryMode: this.deliveryMode,
        ...(degradedReason !== undefined ? { degraded: degradedReason } : {}),
      };
    }

    // Metadata score-1 candidates are plausible enough to inspect but not
    // relevant enough to inject. Fetch only the deterministic top K and
    // re-score the original normalized terms against concise authored
    // content (synthesis + step titles). Gets run concurrently inside the
    // same host deadline as search; Promise.all preserves candidate order.
    // Reuse successful fetched records below so escalation never causes a
    // duplicate corpus/cache read. Any individual failure stays below the
    // floor and records an honest degraded reason (fail open).
    const fetchedRefs: string[] = [];
    const prefetchedByRef = new Map<string, Promise<PortResult<CorpusRecord | null>>>();
    const fetchRecord = (hit: KnowledgeHit): Promise<PortResult<CorpusRecord | null>> => {
      const prefetched = prefetchedByRef.get(hit.ref);
      if (prefetched !== undefined) return prefetched;

      fetchedRefs.push(hit.ref);
      const pending = this.deps.corpus.get(hit.ref).catch((error: unknown) =>
        degraded<CorpusRecord | null>(`corpus get rejected for ${hit.ref}: ${errorReason(error)}`),
      );
      prefetchedByRef.set(hit.ref, pending);
      return pending;
    };

    const resolvePreferredRecord = async (
      hit: KnowledgeHit,
      fetchedRecord: CorpusRecord,
    ): Promise<{
      selectedHit: KnowledgeHit;
      record: CorpusRecord;
      preferredFailureReason?: string;
    }> => {
      let selectedHit = hit;
      let record = fetchedRecord;
      let preferredFailureReason: string | undefined;
      const canonicalEpisodeId = record.canonicalEpisodeId;
      const preferredHit = canonicalEpisodeId === undefined
        ? undefined
        : preferredHitByCanonicalEpisodeId.get(canonicalEpisodeId);

      if (preferredHit !== undefined && preferredHit.ref !== hit.ref) {
        const preferredResult = await fetchRecord(preferredHit);
        if (preferredResult.status === 'unavailable') {
          preferredFailureReason = preferredResult.reason;
        } else {
          if (preferredResult.status === 'degraded') {
            preferredFailureReason = preferredResult.reason;
          }
          const preferredRecord = valueOr(preferredResult, null as CorpusRecord | null);
          if (preferredRecord !== null) {
            selectedHit = preferredHit;
            record = preferredRecord;
          }
        }
      }
      return {
        selectedHit,
        record,
        ...(preferredFailureReason !== undefined ? { preferredFailureReason } : {}),
      };
    };

    const directCandidates = candidates.filter((candidate) => candidate.score >= RELEVANCE_FLOOR);
    const nearMisses = candidates
      .filter((candidate) => candidate.score < RELEVANCE_FLOOR)
      .slice(0, MAX_CONTENT_RESCORE_CANDIDATES);
    const nearMissResults = await Promise.all(
      nearMisses.map(async ({ hit }): Promise<{
        result: PortResult<CorpusRecord | null>;
        selectedHit: KnowledgeHit;
        record: CorpusRecord | null;
        preferredFailureReason?: string;
      }> => {
        const result = await fetchRecord(hit);
        if (result.status === 'unavailable') {
          return { result, selectedHit: hit, record: null };
        }
        const fetchedRecord = valueOr(result, null as CorpusRecord | null);
        if (fetchedRecord === null) return { result, selectedHit: hit, record: null };
        if (
          fetchedRecord.canonicalEpisodeId !== undefined
          && excludedCanonicalEpisodeIds.has(fetchedRecord.canonicalEpisodeId)
        ) {
          return { result, selectedHit: hit, record: null };
        }
        const preferred = await resolvePreferredRecord(hit, fetchedRecord);
        return { result, ...preferred };
      }),
    );

    const promotedCandidates: typeof candidates = [];
    for (let index = 0; index < nearMisses.length; index += 1) {
      const candidate = nearMisses[index]!;
      const nearMissResult = nearMissResults[index]!;
      if (nearMissResult.result.status === 'unavailable') {
        if (degradedReason === undefined) degradedReason = nearMissResult.result.reason;
        continue;
      }
      if (nearMissResult.result.status === 'degraded') {
        degradedReason ??= nearMissResult.result.reason;
      }
      degradedReason ??= nearMissResult.preferredFailureReason;
      const record = nearMissResult.record;
      if (record === null) continue;
      if (record.isSkillPayload === true) continue;
      if (record.retrievalVisible !== true) continue;
      const score = scoreKnowledgeRecord(candidate.hit, record, scoringTerms);
      if (score >= RELEVANCE_FLOOR) promotedCandidates.push({ hit: candidate.hit, score });
    }

    const ranked = rankScoredKnowledgeHits([
      ...directCandidates,
      ...promotedCandidates,
    ]).map((candidate) => candidate.hit);
    if (ranked.length === 0) {
      this.fetchedRefs = fetchedRefs;
      this.deliveryMode = degradedReason === undefined ? 'withheld' : 'degraded';
      return {
        contextBlock: null,
        packets: [],
        searchedTerms: terms,
        retrievalFired: true,
        eligibleRefs: [],
        deliveredRefs: [],
        deliveredCanonicalEpisodeIds: [],
        deliveryMode: this.deliveryMode,
        ...(degradedReason !== undefined ? { degraded: degradedReason } : {}),
      };
    }

    // Fetch full content for ranked candidates and project packets, walking
    // down the ranked list until MAX_SELECTED_PACKETS valid packets are
    // found or candidates are exhausted (mono #1782). Post-fetch guards can
    // disqualify a candidate without spending its slot, promoting the
    // next-ranked one: (1) canonical exclusion/dedup; (2) content-level
    // skill classification — which excludes a legacy skill-shaped record
    // (skill.md step attribute) or a jinn.skill.v1-backed record that slipped
    // the wire kind filter, exactly as a wire kind:'skill' hit is excluded at
    // selection time; (3) retrieval-visibility content verification (#1824,
    // W2) — fail-closed where the other guards are fail-open; (4)
    // empty-packet honesty — a projection with zero excerpts and no synthesis
    // is not evidence. A projection failure degrades that one ref to
    // nothing-found rather than throwing into the caller (§3.5).
    const packets: KnowledgePacket[] = [];
    const deliveredCanonicalEpisodeIds: string[] = [];
    const deliveredCanonicalSet = new Set<string>();
    for (const hit of ranked) {
      if (packets.length >= MAX_SELECTED_PACKETS) break;
      const result = await fetchRecord(hit);
      if (result.status === 'unavailable') {
        if (degradedReason === undefined) degradedReason = result.reason;
        continue;
      }
      if (result.status === 'degraded') degradedReason ??= result.reason;
      const fetchedRecord = valueOr(result, null as CorpusRecord | null);
      if (fetchedRecord === null) continue;
      const fetchedCanonicalEpisodeId = fetchedRecord.canonicalEpisodeId;
      if (
        fetchedCanonicalEpisodeId !== undefined
        && (
          excludedCanonicalEpisodeIds.has(fetchedCanonicalEpisodeId)
          || deliveredCanonicalSet.has(fetchedCanonicalEpisodeId)
        )
      ) {
        continue;
      }

      const {
        selectedHit,
        record,
        preferredFailureReason,
      } = await resolvePreferredRecord(hit, fetchedRecord);
      degradedReason ??= preferredFailureReason;
      const canonicalEpisodeId = record.canonicalEpisodeId;
      if (
        canonicalEpisodeId !== undefined
        && (
          excludedCanonicalEpisodeIds.has(canonicalEpisodeId)
          || deliveredCanonicalSet.has(canonicalEpisodeId)
        )
      ) {
        continue;
      }
      if (record.isSkillPayload === true) continue;
      // Post-fetch content guard (#1824, W2): content is the truth, the
      // search-hit's retrievalVisible was only a hint used to clear ranking.
      // Fail-closed — undefined excludes, exactly like isSkillPayload's
      // fail-open is the opposite case.
      if (record.retrievalVisible !== true) continue;

      let packet: KnowledgePacket;
      try {
        packet = projectKnowledgePacket(record);
      } catch (error) {
        degradedReason ??= `packet projection failed for ${selectedHit.ref}: ${errorReason(error)}`;
        continue;
      }
      if (packet.excerpts.length === 0 && packet.synthesis === undefined) continue;

      packets.push(packet);
      if (canonicalEpisodeId !== undefined) {
        deliveredCanonicalSet.add(canonicalEpisodeId);
        deliveredCanonicalEpisodeIds.push(canonicalEpisodeId);
      }
    }

    this.fetchedRefs = fetchedRefs;
    this.providedRefs = packets.map((packet) => packet.ref);
    this.eligibleRefs = [...this.providedRefs];
    this.packets = packets;

    if (packets.length === 0) {
      this.deliveryMode = degradedReason === undefined ? 'withheld' : 'degraded';
      return {
        contextBlock: null,
        packets: [],
        searchedTerms: terms,
        retrievalFired: true,
        eligibleRefs: this.eligibleRefs,
        deliveredRefs: [],
        deliveredCanonicalEpisodeIds: [],
        deliveryMode: this.deliveryMode,
        ...(degradedReason !== undefined ? { degraded: degradedReason } : {}),
      };
    }

    const contextBlock = renderKnowledgePackets(packets);
    this.deliveryMode = degradedReason === undefined ? 'delivered' : 'degraded';
    this.deliveredContentHash = `sha256:${createHash('sha256').update(contextBlock).digest('hex')}`;
    return {
      contextBlock,
      packets,
      searchedTerms: terms,
      retrievalFired: true,
      eligibleRefs: this.eligibleRefs,
      deliveredRefs: this.providedRefs,
      deliveredCanonicalEpisodeIds,
      deliveryMode: this.deliveryMode,
      deliveredContentHash: this.deliveredContentHash,
      ...(degradedReason !== undefined ? { degraded: degradedReason } : {}),
    };
  }

  noteUserTurn(content: string): void {
    this.pushTurn('user', content);
  }

  noteAssistantTurn(content: string): void {
    this.pushTurn('assistant', content);
  }

  private pushTurn(role: 'user' | 'assistant', content: string): void {
    // A turn is a zero-duration point event on the single unix-nano time base.
    const nowNano = `${Date.now()}000000`;
    this.trajectory.push({
      spanId: randomUUID(),
      parentSpanId: null,
      kind: 'jinn.agent_turn',
      name: 'turn',
      startTimeUnixNano: nowNano,
      endTimeUnixNano: nowNano,
      attributes: { role, content },
      redactedKeys: [],
    });
  }

  noteToolCall(call: ToolCallEvent): void {
    this.trajectory.push({ ...call, kind: 'jinn.tool_call', redactedKeys: call.redactedKeys ?? [] });
  }

  async end(outcome: SessionOutcome): Promise<SessionEndResult> {
    const episode: EpisodeV1 = EpisodeV1WriteSchema.parse({
      schemaVersion: EPISODE_SCHEMA_VERSION,
      episodeId: randomUUID(),
      session: {
        sessionId: this.meta.sessionId,
        capturedAt: this.capturedAt,
        kind: this.meta.kind ?? 'user',
        ...(this.meta.parentSessionId ? { parentSessionId: this.meta.parentSessionId } : {}),
      },
      origin: {
        writer: this.meta.harness.name,
        build: this.meta.harness.version,
      },
      task: {
        summary: this.meta.taskSummary,
        distributionTags: this.meta.distributionTags ?? [],
        ...(this.meta.repositorySlug ? { repositorySlug: this.meta.repositorySlug } : {}),
      },
      trajectory: this.trajectory,
      environment: {
        harness: this.meta.harness,
        model: this.meta.model,
        tools: this.meta.tools,
        skillsLoadout: this.meta.skillsLoadout ?? [],
      },
      outcome: {
        status: outcome.status,
        verificationStrength: outcome.verifiabilityTier,
        ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
        ...(outcome.acceptedDiff !== undefined ? { acceptedDiff: outcome.acceptedDiff } : {}),
        ...(outcome.testRuns !== undefined ? { testRuns: outcome.testRuns } : {}),
      },
      cost: {
        durationMs: outcome.durationMs,
        ...(outcome.tokens ? { tokens: outcome.tokens } : {}),
      },
      retention: { policy: outcome.retentionPolicy },
      provenance: 'contributed',
    });

    return completeSession(
      this.deps,
      {
        contractVersion: JINN_PLUGIN_CONTRACT_VERSION,
        episode,
        activity: {
          searchedTerms: this.searchedTerms,
          providedRefs: this.providedRefs,
          retrievalFired: this.retrievalFired,
          eligibleRefs: this.eligibleRefs,
          deliveredRefs: this.providedRefs,
          deliveryMode: this.deliveryMode,
          ...(this.deliveredContentHash
            ? { deliveredContentHash: this.deliveredContentHash }
            : {}),
          surfacedRefs: [],
          fetchedRefs: this.fetchedRefs,
          installedSkillRefs: [],
        },
        eligibilityInputs: {
          publicRepo: outcome.publicRepo,
          acceptedDiff: outcome.acceptedDiff,
        },
      },
      { providedPackets: this.packets },
    );
  }
}

/**
 * Composes the block the host injects into the first user message, verbatim
 * and cache-safe (rescope §3.4).
 */
function renderKnowledgePacket(packet: KnowledgePacket): string {
  const lines: string[] = [
    `${packet.task.summary} · ${packet.outcome.status}/${packet.outcome.verifiabilityTier}`,
  ];
  if (packet.synthesis) lines.push(packet.synthesis);
  for (const excerpt of packet.excerpts) lines.push(`- ${excerpt.label}: ${excerpt.text}`);
  const capturedDate = packet.attribution.capturedAt.slice(0, 10);
  lines.push(
    `  source: ${packet.ref} · ${packet.attribution.origin} · captured ${capturedDate}`,
  );
  return lines.join('\n');
}

function renderKnowledgePackets(packets: KnowledgePacket[]): string {
  return [
    '[jinn corpus] Prior evidence relevant to this task:',
    ...packets.map(renderKnowledgePacket),
  ].join('\n');
}

export interface JinnPlugin {
  session(meta: SessionMeta): PluginSession;
  completeSession(input: CompleteSessionInput): Promise<SessionEndResult>;
  history(): Promise<HistoryResult>;
  explain(sessionRef: string): Promise<SessionExplanation>;
  previewContribution(acknowledge?: boolean): Promise<PortResult<ContributionPreview | null>>;
  contributionLedger(): Promise<PortResult<ContributionLedgerEntry[]>>;
  disableContributionPublication(): Promise<PortResult<{ recordIds: string[] }>>;
}

export function createJinnPlugin(deps: JinnPluginDeps): JinnPlugin {
  return {
    session(meta: SessionMeta): PluginSession {
      return new PluginSession(deps, meta);
    },
    completeSession(input: CompleteSessionInput): Promise<SessionEndResult> {
      return completeSession(deps, input);
    },
    history(): Promise<HistoryResult> {
      return foldHistory(deps);
    },
    explain(sessionRef: string): Promise<SessionExplanation> {
      return foldExplain(sessionRef, deps);
    },
    previewContribution(acknowledge = false): Promise<PortResult<ContributionPreview | null>> {
      return previewContribution(deps, acknowledge);
    },
    async contributionLedger(): Promise<PortResult<ContributionLedgerEntry[]>> {
      try {
        return await deps.contribution.ledger();
      } catch (error) {
        return unavailable(`contribution ledger failed: ${errorReason(error)}`);
      }
    },
    async disableContributionPublication(): Promise<PortResult<{ recordIds: string[] }>> {
      if (!deps.contribution.disableUnpublished) {
        return unavailable('contribution disable is unavailable');
      }
      try {
        return await deps.contribution.disableUnpublished();
      } catch (error) {
        return unavailable(`contribution disable failed: ${errorReason(error)}`);
      }
    },
  };
}
