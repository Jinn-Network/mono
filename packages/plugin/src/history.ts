/** Derived history + explain views (product design §4.5). Owns no facts —
 *  recomputed from Evidence + Contribution + LocalLearning on every call, so
 *  deleting any cache leaves output identical (there is no cache). */
import {
  deriveContributionStatus,
  type ContributionPort,
  type ContributionLedgerEntry,
} from './ports/contribution-port.js';
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
): Map<string, ContributionLedgerEntry> {
  const map = new Map<string, ContributionLedgerEntry>();
  for (const row of ledger) map.set(row.sourceId, row);
  return map;
}

function contributionState(row: ContributionLedgerEntry | undefined): HistoryEntry['contributionState'] {
  if (!row) return { status: 'none' };
  const anchorRef = row.publicationRef ?? row.mintRef;
  return {
    status: deriveContributionStatus(row),
    ...(anchorRef !== undefined ? { anchorRef } : {}),
  };
}

/**
 * New episodes persist the authoritative completion verdict. Historical v1
 * records omit it, so reads stay backward compatible and honestly indeterminate
 * rather than silently manufacturing a verdict from incomplete inputs.
 */
function episodeEligibility(ep: EpisodeV1): EligibilityVerdict {
  return ep.eligibility ?? {
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
    knowledgeSurfaced: ep.activity?.surfacedRefs.length ?? 0,
    knowledgeUsed: ep.activity?.fetchedRefs.length ?? 0,
    captureStatus: 'captured' as const,
    eligibility: episodeEligibility(ep),
    contributionState: contributionState(byEpisode.get(ep.episodeId)),
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
  const contribution = episode
    ? contributionState(ledger.find((row) => row.sourceId === episode.episodeId))
    : contributionState(undefined);

  return {
    sessionRef,
    found: Boolean(episode),
    surfacedRefs: episode?.activity?.surfacedRefs ?? [],
    fetchedRefs: episode?.activity?.fetchedRefs ?? [],
    installedSkillRefs: episode?.activity?.installedSkillRefs ?? [],
    captureStatus: episode ? 'captured' : 'not-captured',
    eligibility: episode ? episodeEligibility(episode) : null,
    contributionState: contribution,
    degraded: reasons.length > 0,
    ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
  };
}
