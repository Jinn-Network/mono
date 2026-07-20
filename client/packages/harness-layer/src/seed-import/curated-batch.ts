import { deriveRepositorySearchTerms, hasRetrievalMark } from '@jinn-network/plugin';
import { buildSeedScrubPipeline } from '../../../../src/trajectory/scrub/build.js';
import { CORPUS_ONBOARDING_K } from '../corpus-probes.js';
import type { SeedEpisode } from './episode-fetch.js';

export const CURATED_SEED_AUDIT_SCHEMA_VERSION = 'jinn.curated-seed-audit.v1' as const;

export interface CuratedSeedRecordAudit {
  id: string;
  automatedStatus: 'pass' | 'fail';
  errors: string[];
}

export interface CuratedSeedBatchAudit {
  schemaVersion: typeof CURATED_SEED_AUDIT_SCHEMA_VERSION;
  repoSlug: string;
  probeTerms: string[];
  requiredRecords: number;
  recordCount: number;
  eligibleRecordCount: number;
  automatedStatus: 'pass' | 'fail';
  errors: string[];
  records: CuratedSeedRecordAudit[];
  humanCurationRequired: true;
  publishAuthorized: false;
  liveProbe: {
    status: 'not-run';
    command: string;
  };
}

export interface AuditCuratedSeedBatchOptions {
  repoSlug: string;
  episodes: SeedEpisode[];
}

const REQUIRED_STEP_LABELS = ['failure', 'fix', 'command'] as const;
const ACCEPTED_VERIFIABILITY_TIERS = new Set(['tests-passed', 'evaluator-verified']);

/**
 * Audit the automatable portion of a candidate curated seed batch.
 *
 * A passing report means only that the records meet the mechanical evidence,
 * provenance, retrieval, and scrub gates. It deliberately cannot approve the
 * curation judgment, publish records, or claim that a live corpus probe passed.
 */
export async function auditCuratedSeedBatch({
  repoSlug,
  episodes,
}: AuditCuratedSeedBatchOptions): Promise<CuratedSeedBatchAudit> {
  const probeTerms = deriveRepositorySearchTerms(repoSlug);
  const seenIds = new Set<string>();
  const seenSourceUrls = new Set<string>();
  const scrubPipeline = buildSeedScrubPipeline();
  const commitUrlPrefix = `https://github.com/${repoSlug}/commit/`;

  const records: CuratedSeedRecordAudit[] = [];
  for (const episode of episodes) {
    const errors: string[] = [];

    if (episode.repo !== repoSlug) {
      errors.push(`repo must be ${repoSlug}`);
    }
    if (!episode.baseCommit) {
      errors.push('baseCommit must name a full commit');
    }
    if (!hasRetrievalMark(episode.tags)) {
      errors.push('missing retrieval visibility mark');
    }
    if (!probeTerms.some((term) => episode.tags.includes(term))) {
      errors.push(`tags must include a shared probe term: ${probeTerms.join(', ')}`);
    }
    if (
      episode.outcome.status !== 'completed' ||
      !ACCEPTED_VERIFIABILITY_TIERS.has(episode.outcome.verifiabilityTier)
    ) {
      errors.push('outcome must be completed and tests-passed or evaluator-verified');
    }

    const stepLabels = new Set(episode.steps.map((step) => step.label));
    if (!REQUIRED_STEP_LABELS.every((label) => stepLabels.has(label))) {
      errors.push('steps must include failure, fix, and command evidence');
    }
    if (episode.attribution.origin !== 'operator-recorded-session') {
      errors.push('attribution origin must be operator-recorded-session');
    }

    const sourceUrl = episode.attribution.sourceUrl;
    const sourceCommit =
      sourceUrl?.startsWith(commitUrlPrefix) === true
        ? sourceUrl.slice(commitUrlPrefix.length)
        : '';
    if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
      errors.push(`sourceUrl must name a full ${repoSlug} commit`);
    }

    if (seenIds.has(episode.id)) {
      errors.push(`duplicate episode id: ${episode.id}`);
    } else {
      seenIds.add(episode.id);
    }
    if (sourceUrl) {
      if (seenSourceUrls.has(sourceUrl)) {
        errors.push(`duplicate sourceUrl: ${sourceUrl}`);
      } else {
        seenSourceUrls.add(sourceUrl);
      }
    }

    const scrub = await scrubPipeline.run({ 'seed.episode': episode });
    if (scrub.redactions.length > 0) {
      errors.push(
        `seed scrub rejected content: ${scrub.redactions.length} redaction(s) would be required`,
      );
    }

    records.push({
      id: episode.id,
      automatedStatus: errors.length === 0 ? 'pass' : 'fail',
      errors,
    });
  }

  const eligibleRecordCount = records.filter(
    (record) => record.automatedStatus === 'pass',
  ).length;
  const errors: string[] = [];
  const failedRecordCount = records.length - eligibleRecordCount;
  if (failedRecordCount > 0) {
    errors.push(
      `${failedRecordCount} record${failedRecordCount === 1 ? '' : 's'} failed automated checks`,
    );
  }
  if (eligibleRecordCount < CORPUS_ONBOARDING_K) {
    errors.push(
      `need at least ${CORPUS_ONBOARDING_K} mechanically eligible records; found ${eligibleRecordCount}`,
    );
  }

  return {
    schemaVersion: CURATED_SEED_AUDIT_SCHEMA_VERSION,
    repoSlug,
    probeTerms,
    requiredRecords: CORPUS_ONBOARDING_K,
    recordCount: episodes.length,
    eligibleRecordCount,
    automatedStatus: errors.length === 0 ? 'pass' : 'fail',
    errors,
    records,
    humanCurationRequired: true,
    publishAuthorized: false,
    liveProbe: {
      status: 'not-run',
      command: `jinn-layer corpus probe "${repoSlug}" --json`,
    },
  };
}
