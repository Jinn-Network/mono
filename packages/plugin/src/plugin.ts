/**
 * Stage 1 skeleton (S1-F1): real port wiring, stub product policy.
 * `firstTurnPickup` is a direct `corpus.search()` pass-through (no ranking);
 * `end()` assembles buffered turns into a schema-valid EpisodeV1 and persists
 * it via `evidence.put()`. Pickup policy, real eligibility, and
 * history()/explain() are S1-F2 scope (not implemented here) —
 * docs/superpowers/plans/2026-07-14-jinn-plugin-stage-1-plan.md §S1-F2.
 */

/// <reference types="node" />
import { randomUUID } from 'node:crypto';
import type { ContributionPort } from './ports/contribution-port.js';
import type { CorpusPort } from './ports/corpus-port.js';
import type { EvidencePort } from './ports/evidence-port.js';
import type { LocalLearningPort } from './ports/local-learning-port.js';
import type { SkillsPort } from './ports/skills-port.js';
import type { EligibilityVerdict } from './schemas/eligibility-verdict.js';
import { EPISODE_SCHEMA_VERSION, EpisodeV1Schema } from './schemas/episode.js';
import type { EpisodeV1 } from './schemas/episode.js';
import type { KnowledgeHit } from './schemas/knowledge-hit.js';
import type { SessionSummary } from './schemas/session-summary.js';
import type { PortResult } from './outcome.js';

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
  eligibility: EligibilityVerdict;
  summary: SessionSummary;
}

export class PluginSession {
  private readonly trajectory: EpisodeV1['trajectory'] = [];
  private surfacedHits: KnowledgeHit[] = [];
  private readonly capturedAt = new Date().toISOString();

  constructor(
    private readonly deps: JinnPluginDeps,
    private readonly meta: SessionMeta,
  ) {}

  async firstTurnPickup(firstMessage: string): Promise<FirstTurnPickupResult> {
    const result = await this.deps.corpus.search(firstMessage);
    const suggestions = result.status === 'ok' ? result.value : [];
    this.surfacedHits = suggestions;
    return {
      contextBlock: suggestions.length > 0 ? suggestions.map((hit) => hit.title ?? hit.ref).join('\n') : undefined,
      suggestions,
      markers: suggestions.length > 0 ? ['corpus'] : [],
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

    const persistence = await this.deps.evidence.put(episode);

    const eligibility: EligibilityVerdict = {
      eligible: false,
      reason: 'stage-1-stub',
      checkedAt: new Date().toISOString(),
    };

    const summary: SessionSummary = {
      episodeRef: episode.episodeId,
      surfacedHits: this.surfacedHits,
      fetchedHits: [],
      installedSkillRefs: [],
      eligibility,
      nothingFound: this.surfacedHits.length === 0,
    };

    return { episodeRef: episode.episodeId, persistence, eligibility, summary };
  }
}

export interface JinnPlugin {
  session(meta: SessionMeta): PluginSession;
}

export function createJinnPlugin(deps: JinnPluginDeps): JinnPlugin {
  return {
    session(meta: SessionMeta): PluginSession {
      return new PluginSession(deps, meta);
    },
  };
}
