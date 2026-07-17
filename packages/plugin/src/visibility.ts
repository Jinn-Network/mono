/** Retrieval-visibility mark (issue #1824, corpus-supply-design §5 W2): a
 *  reserved, deterministic distribution tag carried inside the signed
 *  jinn.trace-envelope.v0 content (task.distributionTags). Presence is the
 *  sole allowlist signal pickup enforcement keys on — absence excludes,
 *  fail-closed (opposite of the fail-open skill-detection guards). */
export const RETRIEVAL_VISIBLE_TAG = 'retrieval:visible.v1' as const;

export function hasRetrievalMark(tags: readonly string[]): boolean {
  return tags.includes(RETRIEVAL_VISIBLE_TAG);
}
