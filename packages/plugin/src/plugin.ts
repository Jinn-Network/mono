/**
 * Host-neutral Stage 1 product workflow. Embedded hosts buffer their session
 * through `PluginSession`; process hosts pass the already-captured EpisodeV1
 * to `completeSession`. Both paths persist the same canonical evidence and
 * contribution contracts.
 */

/// <reference types="node" />
import { randomUUID } from 'node:crypto';
import type { ContributionPort } from './ports/contribution-port.js';
import type { CorpusPort } from './ports/corpus-port.js';
import type { EvidencePort } from './ports/evidence-port.js';
import type { LocalLearningPort } from './ports/local-learning-port.js';
import type { SkillsPort } from './ports/skills-port.js';
import type { EligibilityVerdict } from './schemas/eligibility-verdict.js';
import {
  EPISODE_SCHEMA_VERSION,
  EpisodeV1Schema,
  SessionActivityFactsSchema,
} from './schemas/episode.js';
import type { EpisodeV1, SessionActivityFacts } from './schemas/episode.js';
import {
  ContributionCandidateV1Schema,
  type ContributionCandidateV1,
} from './schemas/contribution-candidate.js';
import type { KnowledgeHit } from './schemas/knowledge-hit.js';
import type { SessionSummary } from './schemas/session-summary.js';
import {
  decidePickup,
  deriveTerms,
  hitToCandidate,
  renderPickupDecision,
  type PickupCandidate,
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
}

export interface FirstTurnPickupResult {
  contextBlock?: string;
  suggestions: KnowledgeHit[];
  markers: string[];
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
  | { recordId: string }
  | { recordId: string; publicationState: 'vetoed'; status: 'vetoed' };

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
  surfacedHits: KnowledgeHit[];
  fetchedHits: KnowledgeHit[];
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function completeSession(
  deps: JinnPluginDeps,
  input: CompleteSessionInput,
  hits: CompletionSummaryHits = { surfacedHits: [], fetchedHits: [] },
): Promise<SessionEndResult> {
  if (input.contractVersion !== JINN_PLUGIN_CONTRACT_VERSION) {
    throw new Error(`unsupported plugin contract version: ${String(input.contractVersion)}`);
  }

  const capturedEpisode = EpisodeV1Schema.parse(input.episode);
  const activity = SessionActivityFactsSchema.parse(input.activity);
  const eligibility = deriveEligibility(
    {
      status: capturedEpisode.outcome.status,
      verifiabilityTier: capturedEpisode.outcome.verifiabilityTier,
      retentionPolicy: capturedEpisode.retention.policy,
      publicRepo: input.eligibilityInputs.publicRepo,
      acceptedDiff: input.eligibilityInputs.acceptedDiff,
    },
    capturedEpisode.session.capturedAt,
  );
  const episode = EpisodeV1Schema.parse({
    ...capturedEpisode,
    activity,
    eligibility,
  });

  let persistence: PortResult<{ episodeId: string }>;
  try {
    persistence = await deps.evidence.put(episode);
  } catch (error) {
    persistence = unavailable(`evidence put failed: ${errorReason(error)}`);
  }

  let contribution: PortResult<ContributionCompletionReceipt> | undefined;
  if (input.contributionCandidate !== undefined) {
    const parsedCandidate = ContributionCandidateV1Schema.safeParse(input.contributionCandidate);
    if (!parsedCandidate.success) {
      contribution = unavailable('invalid contribution candidate');
    } else if (parsedCandidate.data.sourceId !== episode.episodeId) {
      contribution = unavailable('contribution candidate sourceId must match episodeId');
    } else {
      try {
        contribution = await deps.contribution.recordMineable(
          parsedCandidate.data,
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
      }
    }
  }

  const summary: SessionSummary = {
    episodeRef: episode.episodeId,
    surfacedRefs: activity.surfacedRefs,
    fetchedRefs: activity.fetchedRefs,
    surfacedHits: hits.surfacedHits,
    fetchedHits: hits.fetchedHits,
    installedSkillRefs: activity.installedSkillRefs,
    eligibility,
    nothingFound: activity.surfacedRefs.length === 0,
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
  private surfacedHits: KnowledgeHit[] = [];
  private fetchedHits: KnowledgeHit[] = [];
  private installedSkillRefs: string[] = [];
  private readonly capturedAt = new Date().toISOString();

  constructor(
    private readonly deps: JinnPluginDeps,
    private readonly meta: SessionMeta,
  ) {}

  async firstTurnPickup(firstMessage: string): Promise<FirstTurnPickupResult> {
    const empty: FirstTurnPickupResult = { contextBlock: undefined, suggestions: [], markers: [] };
    const config = parsePickupConfig(this.meta.pickup);
    if (!config.enabled) return empty;

    const terms = deriveTerms(firstMessage);
    if (terms.length === 0) return empty;

    // Phase 1: search per term, dedupe by ref (skip non-ok reads → fail open).
    const byRef = new Map<string, KnowledgeHit>();
    for (const term of terms) {
      const hits = valueOr(await this.deps.corpus.search(term), [] as KnowledgeHit[]);
      for (const hit of hits) if (!byRef.has(hit.ref)) byRef.set(hit.ref, hit);
    }
    if (byRef.size === 0) return empty;

    // Phase 2: get per capped candidate to classify (tier + payloadKind).
    const refs = [...byRef.keys()].slice(0, config.maxCandidates);
    const fetched: KnowledgeHit[] = [];
    const candidates: PickupCandidate[] = [];
    for (const ref of refs) {
      const hit = valueOr(await this.deps.corpus.get(ref), null as KnowledgeHit | null);
      if (!hit) continue;
      fetched.push(hit);
      candidates.push(hitToCandidate(hit));
    }
    this.surfacedHits = fetched;
    this.fetchedHits = fetched;
    if (candidates.length === 0) return empty;

    // Installed-slug dedup (fail open: unknown installed set on non-ok read).
    const listed = valueOr(await this.deps.skills.list(), []);
    const installedSlugs = new Set<string>(listed.map((r) => r.ref.split('/').pop() ?? r.ref));

    const decision = decidePickup(candidates, installedSlugs, config);

    // Auto-adopt actually installs (the adopter rail; dormant by default).
    // Only a confirmed port success may be rendered as an installed skill.
    const adopted: PickupCandidate[] = [];
    const failedAdoptions: PickupCandidate[] = [];
    for (const c of decision.adopted) {
      const res = await this.deps.skills.install(c.ref);
      if (res.status === 'ok') {
        this.installedSkillRefs.push(c.ref);
        adopted.push(c);
      } else {
        failedAdoptions.push(c);
      }
    }

    const contextBlock = renderPickupDecision(
      adopted,
      [...decision.suggested, ...failedAdoptions],
    );

    return {
      contextBlock,
      suggestions: fetched,
      markers: contextBlock ? ['corpus'] : [],
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
    const episode: EpisodeV1 = EpisodeV1Schema.parse({
      schemaVersion: EPISODE_SCHEMA_VERSION,
      episodeId: randomUUID(),
      session: { sessionId: this.meta.sessionId, capturedAt: this.capturedAt },
      task: {
        summary: this.meta.taskSummary,
        distributionTags: this.meta.distributionTags ?? [],
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
        verifiabilityTier: outcome.verifiabilityTier,
        ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
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
          surfacedRefs: this.surfacedHits.map((hit) => hit.ref),
          fetchedRefs: this.fetchedHits.map((hit) => hit.ref),
          installedSkillRefs: this.installedSkillRefs,
        },
        eligibilityInputs: {
          publicRepo: outcome.publicRepo,
          acceptedDiff: outcome.acceptedDiff,
        },
      },
      { surfacedHits: this.surfacedHits, fetchedHits: this.fetchedHits },
    );
  }
}

export interface JinnPlugin {
  session(meta: SessionMeta): PluginSession;
  completeSession(input: CompleteSessionInput): Promise<SessionEndResult>;
  history(): Promise<HistoryResult>;
  explain(sessionRef: string): Promise<SessionExplanation>;
  previewContribution(acknowledge?: boolean): Promise<PortResult<ContributionPreview | null>>;
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
