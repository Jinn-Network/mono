/** Evidence-first pickup policy (rescope design §3.3). No I/O: term
 *  derivation + selection only. Orchestration (search/get over ports,
 *  packet projection, rendering) lives in plugin.ts. */
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

const MAX_TERMS = 6;
const MIN_REMAINDER_LENGTH = 4;

const QUOTED_SPAN_RE = /`([^`]+)`|"([^"]+)"|'([^']+)'/g;

/** Unicode-aware alnum filter (matches Python's `str.isalnum()`), keeping the
 *  identifier separators this function itself tests for — but only when they
 *  are internal. Leading/trailing separators are stripped so ordinary
 *  sentence-final prose (`done.`, `else.`) never reads as identifier-shaped
 *  (mono #1786); a leading `/` on a path-like token (`/v1/status`) is
 *  stripped too — `v1/status` stays a useful, greppable search term, and
 *  treating every separator position the same way keeps the rule one rule. */
function cleanWord(raw: string): string {
  const kept = [...raw].filter((c) => /[\p{L}\p{N}]/u.test(c) || '_-./'.includes(c)).join('');
  return kept.replace(/^[_\-./]+/, '').replace(/[_\-./]+$/, '');
}

/** "Identifier-shaped": contains `_`, `-`, `.`, `/`, a digit, or a camelCase
 *  transition (a lowercase letter immediately followed by an uppercase one). */
function isIdentifierShaped(word: string): boolean {
  return /[_\-./]/.test(word) || /\d/.test(word) || /[a-z][A-Z]/.test(word);
}

/**
 * Up to `maxTerms` deterministic lowercase search terms, in priority order
 * (rescope §3.3): backticked/quoted tokens; identifier-shaped tokens; the
 * session's repository slug; the longest remaining non-stopword tokens.
 * Operates over the whole message (not just the first line). Deduplicated.
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

  // 1. Backticked/quoted tokens — each span is one term, taken near-verbatim.
  for (const match of text.matchAll(QUOTED_SPAN_RE)) {
    if (terms.length >= maxTerms) break;
    push(match[1] ?? match[2] ?? match[3] ?? '');
  }

  // 2. Identifier-shaped tokens (whole message).
  if (terms.length < maxTerms) {
    for (const rawWord of text.split(/\s+/)) {
      if (terms.length >= maxTerms) break;
      const word = cleanWord(rawWord);
      if (word.length < 2 || STOPWORDS.has(word.toLowerCase())) continue;
      if (isIdentifierShaped(word)) push(word);
    }
  }

  // 3. The session's repository slug.
  if (terms.length < maxTerms && repositorySlug && repositorySlug.trim().length > 0) {
    push(repositorySlug);
  }

  // 4. Remaining longest non-stopword tokens (>=4 chars), longest first.
  if (terms.length < maxTerms) {
    const remainder = text
      .split(/\s+/)
      .map(cleanWord)
      .filter((word) => word.length >= MIN_REMAINDER_LENGTH && !STOPWORDS.has(word.toLowerCase()))
      .sort((a, b) => b.length - a.length);
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

const RELEVANCE_FLOOR = 2;
export const MAX_SELECTED_PACKETS = 2;

function haystackFor(hit: KnowledgeHit): string {
  return `${hit.snippet ?? hit.title ?? ''} ${hit.tags.join(' ')}`.toLowerCase();
}

/** Count of matched terms across `taskSummary + tags`; a repository-slug
 *  match counts 2 (rescope §3.3 step 3). */
export function scoreKnowledgeHit(
  hit: KnowledgeHit,
  terms: string[],
  repositorySlug?: string,
): number {
  const haystack = haystackFor(hit);
  const repoTerm = repositorySlug?.trim().toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!haystack.includes(term)) continue;
    score += term.length > 0 && term === repoTerm ? 2 : 1;
  }
  return score;
}

function tierRank(tier: string | undefined): number {
  if (tier === undefined) return -1;
  return (TIER_ORDER as readonly string[]).indexOf(tier);
}

/**
 * Evidence-first selection (rescope §3.3): drop skill hits, dedup, score,
 * apply the relevance floor (honest nothing-found below it), rank
 * score desc → tier desc → recency desc, take the top
 * `MAX_SELECTED_PACKETS`.
 */
export function selectKnowledgeHits(
  hits: KnowledgeHit[],
  terms: string[],
  repositorySlug?: string,
): KnowledgeHit[] {
  const evidence = hits.filter((hit) => !isSkillHit(hit));
  const deduped = dedupeKnowledgeHits(evidence);
  const scored = deduped
    .map((hit) => ({ hit, score: scoreKnowledgeHit(hit, terms, repositorySlug) }))
    .filter((scoredHit) => scoredHit.score >= RELEVANCE_FLOOR);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const tierDiff = tierRank(b.hit.tier) - tierRank(a.hit.tier);
    if (tierDiff !== 0) return tierDiff;
    return (b.hit.publishedAt ?? 0) - (a.hit.publishedAt ?? 0);
  });

  return scored.slice(0, MAX_SELECTED_PACKETS).map((scoredHit) => scoredHit.hit);
}
