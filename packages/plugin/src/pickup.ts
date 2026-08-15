/** Evidence-first pickup policy (rescope design §3.3; lexical v2 term
 *  selection — #1791, #1790, #1789). No I/O: term derivation + selection
 *  only. Orchestration (search/get over ports, packet projection, rendering)
 *  lives in plugin.ts. */
import type { CorpusRecord } from './ports/corpus-port.js';
import type { KnowledgeHit } from './schemas/knowledge-hit.js';
import { TIER_ORDER } from './schemas/pickup-config.js';

// Ported verbatim from the pre-rescope heuristic (still the plugin's stopword list).
export const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'into', 'onto',
  'this', 'that', 'these', 'those', 'from', 'then', 'than', 'when',
  'what', 'which', 'where', 'how', 'why', 'can', 'could', 'should',
  'would', 'will', 'just', 'please', 'help', 'need', 'want', 'make',
  'using', 'about', 'have', 'has', 'had', 'you', 'your', 'our', 'not',
]);

// Lexical v2 (#1791): a tight 6-term budget forced real trade-offs between
// terms that could plausibly match a record's summary/tags — 10 gives
// selection room to include more of the message before the floor decides
// relevance. Search is one cheap indexer call per term.
const MAX_TERMS = 10;
const MIN_REMAINDER_LENGTH = 4;
const MIN_PATH_SEGMENT_LENGTH = 3;
const MIN_REPO_NAME_LENGTH = 3;

const QUOTED_SPAN_RE = /`([^`]+)`|"([^"]+)"|'([^']+)'/g;

/** Unicode-aware alnum filter (matches Python's `str.isalnum()`), keeping the
 *  identifier separators this function itself tests for — but only when they
 *  are internal. Leading/trailing separators are stripped so ordinary
 *  sentence-final prose (`done.`, `else.`) never reads as identifier-shaped
 *  (mono #1786); a leading `/` on a path-like token (`/v1/status`) is
 *  stripped too — `v1/status` stays a useful, greppable search term, and
 *  treating every separator position the same way keeps the rule one rule.
 *  Space is also kept (not just alnum/`_-./`) so this same function is safe
 *  to run on a multi-word backticked/quoted span (#1789) — the other two
 *  call sites split on whitespace first, so a raw space never reaches them
 *  and this is a no-op there. */
function cleanWord(raw: string): string {
  const kept = [...raw].filter((c) => /[\p{L}\p{N}]/u.test(c) || '_-./ '.includes(c)).join('');
  return kept.replace(/^[_\-./]+/, '').replace(/[_\-./]+$/, '');
}

/** "Identifier-shaped": contains `_`, `-`, `.`, `/`, a digit, or a camelCase
 *  transition (a lowercase letter immediately followed by an uppercase one). */
function isIdentifierShaped(word: string): boolean {
  return /[_\-./]/.test(word) || /\d/.test(word) || /[a-z][A-Z]/.test(word);
}

/** Path segments of a `/`-bearing identifier-shaped token (#1791 root cause
 *  1): an over-specific path like `operator/src/dashboard/spa/src` rarely
 *  matches a record's summary/tags verbatim, but a shorter segment within it
 *  (`dashboard`) often does. Each segment is cleaned, filtered to
 *  `MIN_PATH_SEGMENT_LENGTH`, stopword-filtered, and deduplicated against
 *  itself (the caller's `push` handles dedup against the running term list). */
function pathSegments(token: string): string[] {
  const seenLocal = new Set<string>();
  const segments: string[] = [];
  for (const raw of token.split('/')) {
    const cleaned = cleanWord(raw);
    const lower = cleaned.toLowerCase();
    if (cleaned.length < MIN_PATH_SEGMENT_LENGTH || STOPWORDS.has(lower) || seenLocal.has(lower)) {
      continue;
    }
    seenLocal.add(lower);
    segments.push(cleaned);
  }
  return segments;
}

/**
 * The repository vocabulary shared by interactive pickup and repo-scoped
 * corpus probes. A full `owner/repo` slug does not occur in record text; the
 * repository name is the searchable term (#1790). Keep the minimum length in
 * this one helper so non-session consumers cannot drift from pickup.
 */
export function deriveRepositorySearchTerms(repositorySlug?: string): string[] {
  if (!repositorySlug || repositorySlug.trim().length === 0) return [];
  const slug = repositorySlug.trim();
  const lastSlash = slug.lastIndexOf('/');
  const repoName = lastSlash >= 0 ? slug.slice(lastSlash + 1) : slug;
  if (repoName.length < MIN_REPO_NAME_LENGTH) return [];
  return [repoName.toLowerCase()];
}

/**
 * Up to `maxTerms` deterministic lowercase search terms, in priority order
 * (rescope §3.3, lexical v2 — #1791/#1790/#1789): backticked/quoted tokens
 * (edge-stripped, near-verbatim); identifier-shaped tokens — a `/`-bearing
 * one also contributes its path segments, right after the full token; the
 * session repository's NAME (not its full slug, #1790); the remaining
 * non-stopword tokens (>=4 chars) in MESSAGE ORDER — order of first
 * appearance, not longest-first (#1791: length is not a retrievability
 * signal against a corpus of short summaries and tags). Operates over the
 * whole message (not just the first line). Deduplicated.
 */
export function deriveSearchTerms(
  message: string,
  repositorySlug?: string,
  maxTerms = MAX_TERMS,
): string[] {
  const text = message ?? '';
  const terms: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || terms.length >= maxTerms) return;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    terms.push(lower);
  };

  // 1. Backticked/quoted tokens — each span is one term, taken near-verbatim
  //    but run through cleanWord's leading/trailing `_-./` strip (#1789) so
  //    a captured span like "npm test." doesn't keep its trailing period.
  //    cleanWord also keeps internal spaces, so a multi-word span
  //    ("version status fetch") and a path-shaped one ("operator/src/dash")
  //    both keep their shape.
  for (const match of text.matchAll(QUOTED_SPAN_RE)) {
    if (terms.length >= maxTerms) break;
    push(cleanWord(match[1] ?? match[2] ?? match[3] ?? ''));
  }

  // 2. Identifier-shaped tokens (whole message). A `/`-bearing token also
  //    contributes its path segments, right after the full token (#1791
  //    root cause 1) — the full token is often over-specific for a record's
  //    summary/tags, while a shorter segment within it often matches.
  if (terms.length < maxTerms) {
    for (const rawWord of text.split(/\s+/)) {
      if (terms.length >= maxTerms) break;
      const word = cleanWord(rawWord);
      if (word.length < 2 || STOPWORDS.has(word.toLowerCase())) continue;
      if (!isIdentifierShaped(word)) continue;
      push(word);
      if (word.includes('/')) {
        for (const segment of pathSegments(word)) {
          if (terms.length >= maxTerms) break;
          push(segment);
        }
      }
    }
  }

  // 3. The session repository's NAME — the segment after the last `/` of
  //    `repositorySlug` (e.g. `mono` from `Jinn-Network/mono`), not the full
  //    slug: no record's text ever contains the literal `owner/repo` slug,
  //    so the slug itself was dead weight as a search term (#1790).
  if (terms.length < maxTerms) {
    for (const repoTerm of deriveRepositorySearchTerms(repositorySlug)) {
      push(repoTerm);
    }
  }

  // 4. Remaining non-stopword tokens (>=4 chars), in MESSAGE ORDER (#1791
  //    root cause 2) — order of first appearance, not longest-first. Length
  //    is not a retrievability signal: a short on-topic word ("flaky", 5
  //    chars) is a better search term than a long one ("deterministic", 13
  //    chars) against a corpus of short summaries and tags, but the old
  //    longest-first sort always preferred the long word.
  if (terms.length < maxTerms) {
    const remainder = text
      .split(/\s+/)
      .map(cleanWord)
      .filter((word) => word.length >= MIN_REMAINDER_LENGTH && !STOPWORDS.has(word.toLowerCase()));
    for (const word of remainder) {
      if (terms.length >= maxTerms) break;
      push(word);
    }
  }

  return terms;
}

/** Ports classify_payload — 'skill' or 'unknown'. Prefers the explicit
 *  payloadKind classification field; falls back to hit.kind === 'skill'. */
export function classifyPayload(hit: Pick<KnowledgeHit, 'payloadKind' | 'kind'>): 'skill' | 'unknown' {
  if (hit.payloadKind === 'skill') return 'skill';
  if (hit.payloadKind === 'unknown') return 'unknown';
  return hit.kind === 'skill' ? 'skill' : 'unknown';
}

function isSkillHit(hit: KnowledgeHit): boolean {
  return hit.kind === 'skill' || classifyPayload(hit) === 'skill';
}

/** `(taskSummary, origin)` content key — kills the duplicated-seed symptom at
 *  the consumer even before store hygiene lands (rescope §3.3 step 2). Hits
 *  that carry neither a summary/title nor an origin never collide on this key
 *  (an empty key would otherwise collapse unrelated hits). */
function contentKey(hit: KnowledgeHit): string | undefined {
  const summary = (hit.snippet ?? hit.title ?? '').trim().toLowerCase();
  const origin = (hit.origin ?? '').trim().toLowerCase();
  if (summary.length === 0 && origin.length === 0) return undefined;
  return `${summary} ${origin}`;
}

/** Dedup by ref, then by content key (rescope §3.3 step 2). */
export function dedupeKnowledgeHits(hits: KnowledgeHit[]): KnowledgeHit[] {
  const seenRefs = new Set<string>();
  const seenContent = new Set<string>();
  const out: KnowledgeHit[] = [];
  for (const hit of hits) {
    if (seenRefs.has(hit.ref)) continue;
    const key = contentKey(hit);
    if (key !== undefined && seenContent.has(key)) continue;
    seenRefs.add(hit.ref);
    if (key !== undefined) seenContent.add(key);
    out.push(hit);
  }
  return out;
}

export const RELEVANCE_FLOOR = 2;
export const MAX_SELECTED_PACKETS = 2;
export const MAX_CONTENT_RESCORE_CANDIDATES = 3;

export interface ScoredKnowledgeHit {
  hit: KnowledgeHit;
  score: number;
}

function haystackFor(hit: KnowledgeHit): string {
  return `${hit.snippet ?? hit.title ?? ''} ${hit.tags.join(' ')}`.toLowerCase();
}

const REGEX_META_RE = /[.*+?^${}()|[\]\\]/g;

/** Whole-word containment: the term must not be flanked by another word
 *  character (#1886). Plain `includes` matched inside longer words — `load`
 *  hit `payload`, `under` hit `underlying` — and one such accident is enough
 *  to clear `RELEVANCE_FLOOR`. `_` counts as a word character so an
 *  identifier term like `update_available` is not split, while `/`, `-`, `.`
 *  and whitespace remain boundaries, so `dashboard` still matches inside
 *  `operator/src/dashboard/spa`. */
function matchesWholeWord(haystack: string, term: string): boolean {
  const escaped = term.replace(REGEX_META_RE, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(haystack);
}

/** A term matches if it appears as a whole word (#1886), or — for a term
 *  ending in a simple plural `s` — its singular form does (#1791 lexical v2:
 *  closes small, common bag-of-words vocabulary gaps like `tests` -> `test`).
 *  One-directional (term -> singular only) and length-gated
 *  (`term.length > 3`) so a short word like `its` never folds to `it`. */
function termMatches(haystack: string, term: string): boolean {
  if (matchesWholeWord(haystack, term)) return true;
  return term.endsWith('s') && term.length > 3 && matchesWholeWord(haystack, term.slice(0, -1));
}

/**
 * The scoring vocabulary: `terms` minus the repository-name term (#1886).
 *
 * The repository name tags every record in an in-repo corpus, so it matches
 * everything and discriminates nothing — yet it counted 1 toward
 * `RELEVANCE_FLOOR`, halving the effective floor for any query issued inside
 * the repository. It remains a *search* term (it is what surfaces
 * repo-relevant records at all); it just no longer helps a record clear the
 * floor. Callers pass the full list to search and this list to scoring.
 */
export function discriminatingTerms(terms: string[], repositorySlug?: string): string[] {
  const repoTerms = new Set(deriveRepositorySearchTerms(repositorySlug));
  if (repoTerms.size === 0) return terms;
  return terms.filter((term) => !repoTerms.has(term));
}

/** Count of matched terms across `taskSummary + tags` (rescope §3.3 step 3,
 *  lexical v2 — #1790/#1791) — every match counts 1. The repository-slug
 *  match used to count 2, but the slug it matched against could never
 *  appear in a record's text (#1790); the repository's NAME is now a
 *  normal derived term (see `deriveSearchTerms` step 3) and scores like any
 *  other term, with no special case. */
export function scoreKnowledgeHit(hit: KnowledgeHit, terms: string[]): number {
  const haystack = haystackFor(hit);
  let score = 0;
  for (const term of terms) {
    if (term.length === 0) continue;
    if (termMatches(haystack, term)) score += 1;
  }
  return score;
}

/**
 * Re-score an already plausible metadata candidate against the two concise,
 * human-authored content fields available after `CorpusPort.get`: synthesis
 * and step titles. Each original normalized term contributes at most one
 * point across metadata + content, so repeating the same match in synthesis
 * cannot manufacture relevance.
 */
export function scoreKnowledgeRecord(
  hit: KnowledgeHit,
  record: CorpusRecord,
  terms: string[],
): number {
  const metadataHaystack = haystackFor(hit);
  const contentHaystack = [
    record.synthesis ?? '',
    ...record.steps.flatMap((step) => {
      const authoredTitle = step.attributes['seed.step.title'];
      return typeof authoredTitle === 'string'
        ? [step.name, authoredTitle]
        : [step.name];
    }),
  ].join(' ').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (term.length === 0) continue;
    if (termMatches(metadataHaystack, term) || termMatches(contentHaystack, term)) score += 1;
  }
  return score;
}

function tierRank(tier: string | undefined): number {
  if (tier === undefined) return -1;
  return (TIER_ORDER as readonly string[]).indexOf(tier);
}

function compareScoreAndTier(a: ScoredKnowledgeHit, b: ScoredKnowledgeHit): number {
  if (b.score !== a.score) return b.score - a.score;
  return tierRank(b.hit.tier) - tierRank(a.hit.tier);
}

function compareRef(a: ScoredKnowledgeHit, b: ScoredKnowledgeHit): number {
  if (a.hit.ref < b.hit.ref) return -1;
  if (a.hit.ref > b.hit.ref) return 1;
  return 0;
}

/**
 * Return a copied, deterministically ranked scored-candidate list.
 *
 * Recency is a group property, not a pairwise comparator: within each equal
 * score+tier group, use recency only when every hit declares the same domain
 * (including the all-omitted legacy group). A mixed-domain group preserves
 * its stable score/tier input order rather than comparing incomparable
 * recency values or inventing a source priority.
 */
export function rankScoredKnowledgeHits(
  candidates: ScoredKnowledgeHit[],
): ScoredKnowledgeHit[] {
  const grouped = [...candidates].sort(compareScoreAndTier);
  const ranked: ScoredKnowledgeHit[] = [];
  let start = 0;
  while (start < grouped.length) {
    let end = start + 1;
    while (
      end < grouped.length
      && compareScoreAndTier(grouped[start]!, grouped[end]!) === 0
    ) {
      end += 1;
    }

    const tieGroup = grouped.slice(start, end);
    const recencyDomain = tieGroup[0]!.hit.recencyDomain;
    const comparableRecency = tieGroup.every(
      (candidate) => candidate.hit.recencyDomain === recencyDomain,
    );
    if (comparableRecency) {
      tieGroup.sort((a, b) => {
        const recencyDiff =
          (b.hit.publishedAt ?? 0) - (a.hit.publishedAt ?? 0);
        if (recencyDiff !== 0) return recencyDiff;
        return compareRef(a, b);
      });
    }
    ranked.push(...tieGroup);
    start = end;
  }
  return ranked;
}

/**
 * Eligible, deduplicated candidates that have at least one metadata match.
 * Score-1 results are intentionally retained here for the bounded content
 * escalation; `rankKnowledgeHits` remains the honest floor-enforcing API.
 */
export function rankKnowledgeCandidates(
  hits: KnowledgeHit[],
  terms: string[],
): ScoredKnowledgeHit[] {
  const evidence = hits.filter((hit) => !isSkillHit(hit) && hit.retrievalVisible === true);
  const deduped = dedupeKnowledgeHits(evidence);
  return rankScoredKnowledgeHits(
    deduped
      .map((hit) => ({ hit, score: scoreKnowledgeHit(hit, terms) }))
      .filter((scoredHit) => scoredHit.score >= 1),
  );
}

/**
 * Full ranked candidate pool (rescope §3.3 selection policy): drop skill
 * hits, dedup, score, apply the relevance floor (honest nothing-found below
 * it), rank score desc → tier desc → comparable-domain recency desc (or ref
 * for a mixed-domain tie group) — every candidate that clears the floor, not
 * sliced to `MAX_SELECTED_PACKETS`.
 *
 * Content-level guards that can only run after a candidate's content is
 * fetched (mono #1782: post-fetch skill-payload classification, empty-packet
 * honesty) need to walk past a disqualified top candidate to the
 * next-ranked one, so the orchestrator (`plugin.ts` `firstTurnPickup`) walks
 * this unsliced list and does its own promotion-aware slicing.
 * `selectKnowledgeHits` remains the pre-guards convenience wrapper for
 * callers that only need the top slice.
 *
 * Also fail-closed allowlist-filters to `retrievalVisible === true` (#1824,
 * W2) — absence of the field excludes the hit; this is the ranking-side half
 * of the two-layer enforcement, `firstTurnPickup`'s post-fetch content guard
 * is the other half.
 */
export function rankKnowledgeHits(
  hits: KnowledgeHit[],
  terms: string[],
): KnowledgeHit[] {
  return rankKnowledgeCandidates(hits, terms)
    .filter((candidate) => candidate.score >= RELEVANCE_FLOOR)
    .map((candidate) => candidate.hit);
}

/**
 * Evidence-first selection (rescope §3.3): the top `MAX_SELECTED_PACKETS` of
 * `rankKnowledgeHits`. A caller that also needs to apply the post-fetch
 * content-level guards (mono #1782) should walk `rankKnowledgeHits` directly
 * instead — slicing here happens before those guards can run, so a
 * candidate they disqualify would lose its slot rather than promoting the
 * next-ranked one.
 */
export function selectKnowledgeHits(
  hits: KnowledgeHit[],
  terms: string[],
): KnowledgeHit[] {
  return rankKnowledgeHits(hits, terms).slice(0, MAX_SELECTED_PACKETS);
}
