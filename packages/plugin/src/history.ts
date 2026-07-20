/** Derived history + explain views (product design §4.5). Owns no facts —
 *  recomputed from Evidence + Contribution + LocalLearning on every call, so
 *  deleting any cache leaves output identical (there is no cache). */
import {
  deriveContributionStatus,
  type ContributionPort,
  type ContributionLedgerEntry,
} from './ports/contribution-port.js';
import type { EvidencePort } from './ports/evidence-port.js';
import type { LocalLearningPort, LocalLearningSkill } from './ports/local-learning-port.js';
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
  unavailable: boolean;
  reason?: string;
}

export interface SessionExplanation {
  sessionRef: string;
  found: boolean;
  searchedTerms: string[];
  providedRefs: string[];
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

function contributionState(
  row: ContributionLedgerEntry | undefined,
  available = true,
): HistoryEntry['contributionState'] {
  if (!available) return { status: 'unavailable' };
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
function episodeEligibility(ep: EpisodeV1): EligibilityVerdict | null {
  return ep.eligibility ?? null;
}

/**
 * Canonical searched/provided activity from the new fields, falling back to
 * the legacy surfaced/fetched refs for episodes captured before the rescope
 * (rescope §3.6). An episode is "legacy" here when both new fields are empty
 * AND at least one legacy field is not — a genuinely new episode with a
 * nothing-found result has both sides empty, so the fallback is a no-op for it.
 * Reads defensively (`?? []`): an `EvidencePort` is not required to
 * schema-validate on read (the in-memory test double does not), so a record
 * older than any given field must not crash the fold.
 */
function canonicalKnowledgeActivity(
  activity: EpisodeV1['activity'],
): { searchedTerms: string[]; providedRefs: string[] } {
  if (!activity) return { searchedTerms: [], providedRefs: [] };
  const searchedTerms = activity.searchedTerms ?? [];
  const providedRefs = activity.providedRefs ?? [];
  const surfacedRefs = activity.surfacedRefs ?? [];
  const fetchedRefs = activity.fetchedRefs ?? [];
  const installedSkillRefs = activity.installedSkillRefs ?? [];
  const isLegacy = searchedTerms.length === 0
    && providedRefs.length === 0
    && (surfacedRefs.length > 0 || fetchedRefs.length > 0 || installedSkillRefs.length > 0);
  return isLegacy
    ? { searchedTerms: surfacedRefs, providedRefs: fetchedRefs }
    : { searchedTerms, providedRefs };
}

function knowledgeCounts(activity: EpisodeV1['activity']): { surfaced: number; used: number } {
  const canonical = canonicalKnowledgeActivity(activity);
  return { surfaced: canonical.searchedTerms.length, used: canonical.providedRefs.length };
}

function skillsBySession(skills: LocalLearningSkill[]): Map<string, HistoryEntry['distilledSkills']> {
  const bySession = new Map<string, NonNullable<HistoryEntry['distilledSkills']>>();
  for (const skill of skills) {
    for (const sessionId of skill.sourceSessionIds) {
      const rows = bySession.get(sessionId) ?? [];
      if (!rows.some((row) => row.ref === skill.ref && row.state === skill.state)) {
        rows.push({ ref: skill.ref, state: skill.state });
      }
      bySession.set(sessionId, rows);
    }
  }
  return bySession;
}

export async function foldHistory(deps: HistoryDeps): Promise<HistoryResult> {
  const reasons: string[] = [];

  const episodesResult = await deps.evidence.list();
  const episodes = collect(episodesResult, 'evidence', [] as EpisodeV1[], reasons);
  const ledgerResult = await deps.contribution.ledger();
  const ledger = collect(ledgerResult, 'contribution', [] as ContributionLedgerEntry[], reasons);
  const skillsResult = deps.localLearning.skills
    ? await deps.localLearning.skills()
    : ({ status: 'unavailable', reason: 'skill provenance is unavailable' } as const);
  const skills = collect(skillsResult, 'localLearning', [] as LocalLearningSkill[], reasons);

  const byEpisode = ledgerByEpisode(ledger);
  const bySession = skillsBySession(skills);
  const contributionAvailable = ledgerResult.status !== 'unavailable';
  const skillsAvailable = skillsResult.status !== 'unavailable';

  const entries: HistoryEntry[] = [...episodes]
    .filter((ep) => ep.session.kind !== 'host-internal')
    .sort((a, b) => b.session.capturedAt.localeCompare(a.session.capturedAt))
    .map((ep) => {
      const counts = knowledgeCounts(ep.activity);
      return {
        sessionId: ep.session.sessionId,
        capturedAt: ep.session.capturedAt,
        taskSummary: ep.task.summary,
        knowledgeSurfaced: ep.activity ? counts.surfaced : null,
        knowledgeUsed: ep.activity ? counts.used : null,
        captureStatus: 'captured' as const,
        eligibility: episodeEligibility(ep),
        contributionState: contributionState(byEpisode.get(ep.episodeId), contributionAvailable),
        distilledSkills: skillsAvailable ? bySession.get(ep.session.sessionId) ?? [] : null,
      };
    });

  const legacyFactsUnavailable = episodes.some((ep) => !ep.activity || !ep.eligibility);
  if (legacyFactsUnavailable) reasons.push('one or more episodes predate activity or eligibility facts');
  const evidenceUnavailable = episodesResult.status === 'unavailable';

  return reasons.length > 0
    ? { entries, degraded: true, unavailable: evidenceUnavailable, reason: reasons.join('; ') }
    : { entries, degraded: false, unavailable: false };
}

export async function foldExplain(sessionRef: string, deps: HistoryDeps): Promise<SessionExplanation> {
  const reasons: string[] = [];

  const episodes = collect(await deps.evidence.list(), 'evidence', [] as EpisodeV1[], reasons);
  const ledgerResult = await deps.contribution.ledger();
  const ledger = collect(ledgerResult, 'contribution', [] as ContributionLedgerEntry[], reasons);

  const episode = episodes.find((ep) => ep.session.sessionId === sessionRef);
  const contribution = episode
    ? contributionState(
        ledger.find((row) => row.sourceId === episode.episodeId),
        ledgerResult.status !== 'unavailable',
      )
    : contributionState(undefined, ledgerResult.status !== 'unavailable');
  const activity = canonicalKnowledgeActivity(episode?.activity);

  return {
    sessionRef,
    found: Boolean(episode),
    searchedTerms: activity.searchedTerms,
    providedRefs: activity.providedRefs,
    captureStatus: episode ? 'captured' : 'not-captured',
    eligibility: episode ? episodeEligibility(episode) : null,
    contributionState: contribution,
    degraded: reasons.length > 0,
    ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
  };
}
