/**
 * `executeEpisodes()` — publish approved evidence-episode rows through the
 * SAME `capture() -> publish()` path skill seeds use (issue #1771). Each
 * episode becomes a synthetic captured task: one step per authored
 * `SeedEpisodeStep` (content), plus a final step carrying the synthesis +
 * attribution (episode-fetch.ts's step convention). `provenance: 'imported'`
 * throughout, same as skill seeds — excluded from the demand signal and
 * emissions eligibility by every provenance-aware reader.
 *
 * Idempotent by seed identity (state.ts, shared with the skill lane):
 * unchanged content republishes nothing; changed content republishes and
 * points the new record's `seed.attribution.supersedes` at the prior
 * envelopeRef.
 */

import { capture, type CapturedTask } from '../capture.js';
import { buildSeedScrubPipeline } from '@jinn-network/core/scrub';
import {
  publish,
  PublishLedgerError,
  type HarnessPublishDeps,
  type PublishResult,
} from '../publish.js';
import type { Attributes } from '@jinn-network/core/scrub';
import { episodeContentDigest, type EpisodeSource, type SeedEpisode } from './episode-fetch.js';
import type { EpisodeImportReport } from './episode-report.js';
import {
  createMemorySeedImportState,
  type SeedImportStateStore,
} from './state.js';

export interface EpisodeImportResult {
  imported: Array<{
    id: string;
    envelopeRef: string;
    anchorTx: string | null;
    /** Prior envelopeRef this publish supersedes, or null for a fresh identity. */
    supersedes: string | null;
    /** Publication succeeded, but local lineage state needs operator recovery. */
    stateWarning?: string;
    /** Anchor succeeded, but the local publication ledger needs recovery. */
    ledgerWarning?: string;
  }>;
  skipped: Array<{ id: string; reason: string }>;
  errors: Array<{ id: string; error: string }>;
}

/** Same caps as seed-import/execute.ts's skill tags (envelope-v0.md size limits). */
const MAX_TAG_CHARS = 64;
const MAX_TAGS = 16;

/**
 * Episode tags: the `seed-import` marker (shared with skill seeds — the
 * "how did this land in the corpus" signal) plus the episode's own declared
 * tags, deduped and capped. Mirrors `seedTags()` in execute.ts.
 */
export function publishedEpisodeTags(episode: SeedEpisode): string[] {
  const tags: string[] = [];
  for (const candidate of ['seed-import', ...episode.tags]) {
    const tag = candidate.trim().slice(0, MAX_TAG_CHARS);
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, MAX_TAGS);
}

function toCapturedTask(episode: SeedEpisode, now: Date, supersedes: string | undefined): CapturedTask {
  const nanoBase = now.getTime();
  const nanoAt = (offset: number) => `${nanoBase + offset}000000`;

  const contentSteps: CapturedTask['steps'] = episode.steps.map((step, i) => ({
    spanId: `seed-${i + 1}`,
    parentSpanId: null,
    name: `seed:step:${step.label}`,
    startTimeUnixNano: nanoAt(i),
    endTimeUnixNano: nanoAt(i),
    attributes: {
      'seed.step.label': step.label,
      'seed.step.title': step.title,
      'seed.step.text': step.text,
    },
    redactedKeys: [],
  }));

  const metaIndex = contentSteps.length;
  const metaStep: CapturedTask['steps'][number] = {
    spanId: `seed-${metaIndex + 1}`,
    parentSpanId: null,
    name: 'seed:synthesis',
    startTimeUnixNano: nanoAt(metaIndex),
    endTimeUnixNano: nanoAt(metaIndex),
    attributes: {
      'seed.synthesis': episode.synthesis,
      'seed.attribution': {
        repo: episode.repo,
        ...(episode.baseCommit ? { baseCommit: episode.baseCommit } : {}),
        origin: episode.attribution.origin,
        ...(episode.attribution.sourceUrl ? { sourceUrl: episode.attribution.sourceUrl } : {}),
        ...(supersedes ? { supersedes } : {}),
      },
    },
    redactedKeys: [],
  };

  return {
    session: { sessionId: `seed-episode:${episode.id}`, capturedAt: now.toISOString() },
    task: {
      summary: episode.taskSummary,
      distributionTags: publishedEpisodeTags(episode),
      repositorySlug: episode.repo,
      ...(episode.baseCommit ? { baseCommit: episode.baseCommit } : {}),
    },
    environment: {
      harness: { name: 'jinn-layer-seed-episode-import', version: '0.1.0' },
      model: 'none',
      tools: [],
    },
    steps: [...contentSteps, metaStep],
    outcome: { status: episode.outcome.status, verifiabilityTier: episode.outcome.verifiabilityTier },
    cost: { durationMs: 0 },
    provenance: 'imported',
  };
}

/** Every episode-originated string that can influence the published envelope. */
function episodePrivacyAttributes(episode: SeedEpisode): Attributes {
  const attributes: Attributes = {
    'episode.id': episode.id,
    'episode.repo': episode.repo,
    'episode.taskSummary': episode.taskSummary,
    'episode.outcome.status': episode.outcome.status,
    'episode.outcome.verifiabilityTier': episode.outcome.verifiabilityTier,
    'episode.synthesis': episode.synthesis,
    'episode.attribution.origin': episode.attribution.origin,
  };
  if (episode.baseCommit) attributes['episode.baseCommit'] = episode.baseCommit;
  if (episode.attribution.sourceUrl) {
    attributes['episode.attribution.sourceUrl'] = episode.attribution.sourceUrl;
  }
  episode.tags.forEach((tag, index) => {
    attributes[`episode.tags[${index}]`] = tag;
  });
  episode.steps.forEach((step, index) => {
    attributes[`episode.steps[${index}].label`] = step.label;
    attributes[`episode.steps[${index}].title`] = step.title;
    attributes[`episode.steps[${index}].text`] = step.text;
  });
  return attributes;
}

/** Read-only privacy preflight shared by execute and curated-batch auditing. */
export async function seedEpisodePrivacyRedactionCount(
  episode: SeedEpisode,
): Promise<number> {
  const scrub = await buildSeedScrubPipeline().run(episodePrivacyAttributes(episode));
  return scrub.redactions.length;
}

export async function executeEpisodes(
  report: EpisodeImportReport,
  source: EpisodeSource,
  deps: HarnessPublishDeps,
  opts: { state?: SeedImportStateStore } = {},
): Promise<EpisodeImportResult> {
  const episodes = new Map<string, SeedEpisode>();
  for (const episode of await source.list()) {
    if (!episodes.has(episode.id)) episodes.set(episode.id, episode);
  }
  const result: EpisodeImportResult = { imported: [], skipped: [], errors: [] };
  const now = deps.now?.() ?? new Date();
  // Evidence episodes are public, transformed, human-reviewed seeds — like
  // the skill lane, not operator trace data — so they run the seed profile
  // (plan §4.4; spec/2026-07-02-jinn-harness-network.md §7): deterministic
  // key policy, plain-patterns, and secretlint pass-1 only. The strict
  // trace profile's probabilistic stages (openredaction, entropy fallback)
  // false-positive on ordinary words and hex-looking SHAs in this content
  // (#1784) and are not appropriate for a pre-vetted, checked-in corpus.
  const episodeScrubPipeline = buildSeedScrubPipeline();
  const state = opts.state ?? createMemorySeedImportState();

  for (const row of report) {
    if (row.verdict === 'skip') {
      result.skipped.push({ id: row.id, reason: row.reason });
      continue;
    }
    try {
      const episode = episodes.get(row.id);
      if (!episode) throw new Error(`episode ${row.id} not found in source ${source.name}`);

      const identity = `episode:${episode.id}`;
      const contentHash = episodeContentDigest(episode);
      if (contentHash !== row.contentDigest) {
        throw new Error(
          `approved content digest ${row.contentDigest} does not match execute-time digest ${contentHash} for ${row.id}`,
        );
      }
      let prior: ReturnType<SeedImportStateStore['get']>;
      try {
        prior = state.get(identity);
      } catch (err) {
        result.errors.push({
          id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
      if (prior && prior.contentHash === contentHash) {
        result.skipped.push({ id: row.id, reason: `unchanged since ${prior.envelopeRef}` });
        continue;
      }

      const privacy = await episodeScrubPipeline.run(episodePrivacyAttributes(episode));
      if (privacy.redactions.length > 0) {
        const detectors = [
          ...new Set(privacy.redactions.map((redaction) =>
            `${redaction.stage}${redaction.detail ? `:${redaction.detail}` : ''}`)),
        ];
        throw new Error(
          `sensitive content detected (${detectors.join(', ')}); refusing to publish evidence episode ${row.id}`,
        );
      }

      const pending = await capture(toCapturedTask(episode, now, prior?.envelopeRef), {
        pipeline: episodeScrubPipeline,
      });
      const sensitiveRedactions = pending.redactions.filter((redaction) => redaction.stage !== 'fit');
      if (sensitiveRedactions.length > 0) {
        const detectors = [
          ...new Set(sensitiveRedactions.map((redaction) =>
            `${redaction.stage}${redaction.detail ? `:${redaction.detail}` : ''}`)),
        ];
        throw new Error(
          `sensitive content detected (${detectors.join(', ')}); refusing to publish evidence episode ${row.id}`,
        );
      }
      let published: PublishResult;
      let ledgerWarning: string | undefined;
      try {
        published = await publish(pending, deps);
      } catch (err) {
        if (err instanceof PublishLedgerError) {
          published = err.result;
          ledgerWarning = err.message;
        } else {
          const detail = err instanceof Error ? err.message : String(err);
          result.errors.push({
            id: row.id,
            error: `publication outcome unknown; do not auto-retry: ${detail}`,
          });
          break;
        }
      }
      if (published.vetoed) throw new Error('unexpected veto on seed publish');

      let stateWarning: string | undefined;
      try {
        state.set(identity, { contentHash, envelopeRef: published.envelopeRef, publishedAt: now.toISOString() });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        stateWarning =
          `published ${published.envelopeRef}, but seed-import state persistence failed: ${detail}; ` +
          'recovery required before retrying this episode';
      }
      result.imported.push({
        id: row.id,
        envelopeRef: published.envelopeRef,
        anchorTx: published.anchorTx,
        supersedes: prior?.envelopeRef ?? null,
        ...(ledgerWarning ? { ledgerWarning } : {}),
        ...(stateWarning ? { stateWarning } : {}),
      });
      if (ledgerWarning || stateWarning) break;
    } catch (err) {
      result.errors.push({
        id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
