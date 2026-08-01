// SPDX-License-Identifier: Apache-2.0

/**
 * FTS5's `unicode61` tokenizer treats every non-alphanumeric character as a separator, so
 * `snake_case`, dotted, and slashed identifiers already tokenize well. The one shape it
 * mis-handles is camelCase: `parseTrajectory` becomes the single token
 * `parsetrajectory`, so a query for `trajectory` misses it. This pass emits an expanded
 * copy into parallel FTS columns, which is cheaper than a second index.
 */
const CAMEL_BOUNDARY = /(\p{Ll})(\p{Lu})/gu;
const ACRONYM_BOUNDARY = /(\p{Lu}+)(\p{Lu}\p{Ll})/gu;
const LETTER_DIGIT_BOUNDARY = /(\p{L})(\p{N})/gu;
const DIGIT_LETTER_BOUNDARY = /(\p{N})(\p{L})/gu;

export function expandIdentifiers(text: string): string {
  return text
    .replace(ACRONYM_BOUNDARY, "$1 $2")
    .replace(CAMEL_BOUNDARY, "$1 $2")
    .replace(LETTER_DIGIT_BOUNDARY, "$1 $2")
    .replace(DIGIT_LETTER_BOUNDARY, "$1 $2");
}

/**
 * A term with no alphanumeric character tokenizes to an empty phrase, which FTS5 rejects
 * as a syntax error. Such terms are dropped before they reach the matcher.
 */
export function isSearchableTerm(term: string): boolean {
  return /[\p{L}\p{N}]/u.test(term);
}

/**
 * Terms originate in the user's message. Every one reaches FTS5 as a quoted phrase so that
 * `OR`, `NEAR`, `*`, `:`, `(`, and `"` are inert text rather than query syntax — the
 * message must not be able to steer the matcher.
 */
export function ftsPhrase(term: string): string {
  return `"${term.replace(/"/gu, '""')}"`;
}

export function ftsColumnQuery(columns: readonly string[], term: string): string {
  return `{${columns.join(" ")}} : ${ftsPhrase(term)}`;
}
