/** Derived history + explain views (product design §4.5). Owns no facts —
 *  recomputed from Evidence + Contribution + LocalLearning on every call, so
 *  deleting any cache leaves output identical (there is no cache). */
import type { ContributionPort, ContributionLedgerEntry } from './ports/contribution-port.js';
import type { EvidencePort } from './ports/evidence-port.js';
import type { LocalLearningPort } from './ports/local-learning-port.js';
import type { EpisodeV1 } from './schemas/episode.js';
import type { EligibilityVerdict } from './schemas/eligibility-verdict.js';
import type { HistoryEntry } from './schemas/history-entry.js';
import type { PortResult } from './outcome.js';
import { unwrap } from './outcome.js';

export interface HistoryDeps {
  evidence: EvidencePort;
  contribution: ContributionPort;
  localLearning: LocalLearningPort;
}

export interface HistoryResult {
  entries: HistoryEntry[];
  degraded: boolean;
  reason?: string;
}

export interface SessionExplanation {
  sessionRef: string;
  found: boolean;
  surfacedRefs: string[];
  fetchedRefs: string[];
  installedSkillRefs: string[];
  captureStatus: 'captured' | 'not-captured';
  eligibility: EligibilityVerdict | null;
  contributionState: { status: HistoryEntry['contributionState']['status']; anchorRef?: string };
  degraded: boolean;
  reason?: string;
}

/** Fail-open list unwrap that records a labelled reason on non-ok reads. */
function collect<T>(res: PortResult<T[]>, label: string, fallback: T[], reasons: string[]): T[] {
  const { value, reason } = unwrap(res, fallback);
  if (reason !== undefined) reasons.push(`${label}: ${reason}`);
  return value;
}

function ledgerByEpisode(
  ledger: ContributionLedgerEntry[],
): Map<string, ContributionLedgerEntry['status']> {
  const map = new Map<string, ContributionLedgerEntry['status']>();
  for (const row of ledger) map.set(row.episodeId, row.status);
  return map;
}

/**
 * History cannot re-derive an eligibility verdict: `deriveEligibility` reads the
 * accepted-diff / public-repo contribution signals that `end()` sees at
 * session-close, but EpisodeV1 does not persist them (episode-schema mechanics
 * are out of S1-F2 scope). Recomputing from the persisted `status`/tier/policy
 * alone would silently manufacture a `false` verdict from absent signals and
 * disagree with the authoritative `end()` verdict for the same episode. So
 * history reports the verdict as honestly indeterminate. `checkedAt` is pinned
 * to `capturedAt` to keep history deterministic (AC3 reproducibility).
 */
function episodeEligibility(ep: EpisodeV1): EligibilityVerdict {
  return {
    eligible: false,
    reason: 'eligibility indeterminate from episode (contribution signals not persisted)',
    checkedAt: ep.session.capturedAt,
  };
}

export async function foldHistory(deps: HistoryDeps): Promise<HistoryResult> {
  const reasons: string[] = [];

  const episodes = collect(await deps.evidence.list(), 'evidence', [] as EpisodeV1[], reasons);
  const ledger = collect(await deps.contribution.ledger(), 'contribution', [] as ContributionLedgerEntry[], reasons);

  const runsRes = await deps.localLearning.list();
  if (runsRes.status !== 'ok') reasons.push(`localLearning: ${runsRes.reason}`);

  const byEpisode = ledgerByEpisode(ledger);

  const entries: HistoryEntry[] = episodes.map((ep) => ({
    sessionId: ep.session.sessionId,
    taskSummary: ep.task.summary,
    knowledgeSurfaced: 0,
    knowledgeUsed: 0,
    captureStatus: 'captured' as const,
    eligibility: episodeEligibility(ep),
    contributionState: { status: byEpisode.get(ep.episodeId) ?? ('none' as const) },
    distilledSkillRefs: [],
  }));

  return reasons.length > 0
    ? { entries, degraded: true, reason: reasons.join('; ') }
    : { entries, degraded: false };
}

export async function foldExplain(sessionRef: string, deps: HistoryDeps): Promise<SessionExplanation> {
  const reasons: string[] = [];

  const episodes = collect(await deps.evidence.list(), 'evidence', [] as EpisodeV1[], reasons);
  const ledger = collect(await deps.contribution.ledger(), 'contribution', [] as ContributionLedgerEntry[], reasons);

  const episode = episodes.find((ep) => ep.session.sessionId === sessionRef);
  const status = episode
    ? ledger.find((row) => row.episodeId === episode.episodeId)?.status ?? ('none' as const)
    : ('none' as const);

  return {
    sessionRef,
    found: Boolean(episode),
    surfacedRefs: [],
    fetchedRefs: [],
    installedSkillRefs: [],
    captureStatus: episode ? 'captured' : 'not-captured',
    eligibility: episode ? episodeEligibility(episode) : null,
    contributionState: { status },
    degraded: reasons.length > 0,
    ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
  };
}
