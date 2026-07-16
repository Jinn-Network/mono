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
import { buildScrubPipeline } from '../../../../src/trajectory/scrub/build.js';
import { publish, type HarnessPublishDeps } from '../publish.js';
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
function episodeTags(episode: SeedEpisode): string[] {
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
    task: { summary: episode.taskSummary, distributionTags: episodeTags(episode) },
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
  // Evidence episodes can contain copied command output and must use the
  // strict deterministic trace profile: structured PII plus entropy-backed
  // secret detection. The skill lane intentionally keeps its permissive
  // public-prose profile (#1409).
  const episodeScrubPipeline = buildScrubPipeline();
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
      const prior = state.get(identity);
      if (prior && prior.contentHash === contentHash) {
        result.skipped.push({ id: row.id, reason: `unchanged since ${prior.envelopeRef}` });
        continue;
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
      const published = await publish(pending, deps);
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
        ...(stateWarning ? { stateWarning } : {}),
      });
    } catch (err) {
      result.errors.push({
        id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
