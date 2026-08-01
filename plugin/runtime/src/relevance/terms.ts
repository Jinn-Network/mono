// SPDX-License-Identifier: Apache-2.0

/**
 * Search-term derivation from the session's first message and repository.
 *
 * Policy source: `packages/plugin/src/pickup.ts` (frozen reference — read for the
 * function, never copied). The reference's path-segment expansion is deliberately absent:
 * it compensated for a substring matcher, and this component indexes with an FTS5
 * tokenizer that already splits on `/`, `.`, `-`, and `_`.
 */

export const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "for", "with", "into", "onto",
  "this", "that", "these", "those", "from", "then", "than", "when",
  "what", "which", "where", "how", "why", "can", "could", "should",
  "would", "will", "just", "please", "help", "need", "want", "make",
  "using", "about", "have", "has", "had", "you", "your", "our", "not",
  "me", "my", "it", "is", "are", "was", "were", "be", "been", "do", "does",
]);

const DEFAULT_MAX_TERMS = 10;
const MIN_REMAINDER_LENGTH = 4;
const MIN_REPOSITORY_NAME_LENGTH = 3;
const QUOTED_SPAN = /`([^`]+)`|"([^"]+)"|'([^']+)'/gu;
const EDGE_SEPARATORS = /^[_\-./]+|[_\-./]+$/gu;

/**
 * Keep letters, digits, the identifier separators, and internal spaces (so a multi-word
 * quoted span survives as one term); strip separators at the edges so ordinary
 * sentence-final prose (`failed.`) never reads as identifier-shaped.
 */
function cleanToken(raw: string): string {
  const kept = [...raw]
    .filter((character) => /[\p{L}\p{N}]/u.test(character) || "_-./ ".includes(character))
    .join("");
  return kept.replace(EDGE_SEPARATORS, "").trim();
}

function isIdentifierShaped(token: string): boolean {
  return /[_\-./]/u.test(token) || /\d/u.test(token) || /[a-z][A-Z]/u.test(token);
}

/**
 * The repository vocabulary. A full `owner/repo` slug does not occur in record text; the
 * repository name is the searchable term.
 */
export function deriveRepositorySearchTerms(
  repositorySlug?: string,
): readonly string[] {
  const slug = repositorySlug?.trim() ?? "";
  if (slug.length === 0) return [];
  const lastSlash = slug.lastIndexOf("/");
  const name = lastSlash >= 0 ? slug.slice(lastSlash + 1) : slug;
  if (name.length < MIN_REPOSITORY_NAME_LENGTH) return [];
  return [name.toLowerCase()];
}

/**
 * Up to `maxTerms` deterministic lowercase search terms, in priority order:
 * quoted/backticked spans, identifier-shaped tokens, the repository name, then the
 * remaining non-stopword tokens in message order. Deduplicated.
 */
export function deriveSearchTerms(
  message: string,
  repositorySlug?: string,
  maxTerms: number = DEFAULT_MAX_TERMS,
): readonly string[] {
  const text = message ?? "";
  const terms: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string): void => {
    if (terms.length >= maxTerms) return;
    const cleaned = cleanToken(raw);
    if (cleaned.length === 0) return;
    const lower = cleaned.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    terms.push(lower);
  };

  for (const match of text.matchAll(QUOTED_SPAN)) {
    if (terms.length >= maxTerms) break;
    push(match[1] ?? match[2] ?? match[3] ?? "");
  }

  for (const raw of text.split(/\s+/u)) {
    if (terms.length >= maxTerms) break;
    const token = cleanToken(raw);
    if (token.length < 2 || STOPWORDS.has(token.toLowerCase())) continue;
    if (isIdentifierShaped(token)) push(token);
  }

  for (const repositoryTerm of deriveRepositorySearchTerms(repositorySlug)) {
    push(repositoryTerm);
  }

  for (const raw of text.split(/\s+/u)) {
    if (terms.length >= maxTerms) break;
    const token = cleanToken(raw);
    if (token.length < MIN_REMAINDER_LENGTH) continue;
    if (STOPWORDS.has(token.toLowerCase())) continue;
    push(token);
  }

  return terms;
}

/**
 * The scoring vocabulary: `terms` minus the repository-name term. The repository name tags
 * every record in an in-repo corpus, so it matches everything and discriminates nothing —
 * yet it would count toward the relevance floor and halve it for every query issued inside
 * the repository. It remains a *search* term; it just cannot help a record clear the floor.
 */
export function discriminatingTerms(
  terms: readonly string[],
  repositorySlug?: string,
): readonly string[] {
  const repositoryTerms = new Set(deriveRepositorySearchTerms(repositorySlug));
  if (repositoryTerms.size === 0) return terms;
  return terms.filter((term) => !repositoryTerms.has(term));
}
