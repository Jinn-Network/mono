/**
 * The daemon's product mode: `legacy` (the compatibility graph) or `native-v1`. Lives here rather
 * than in `daemon/native-vertical-mode.ts` (the canonical resolver — see
 * `resolveOperatorVerticalMode` there) so neutral consumers like `src/api/` can reference the type
 * without importing across the api → daemon architecture boundary (#1584; enforced by
 * `test/architecture/api-daemon-boundary.test.ts`). `daemon/native-vertical-mode.ts` re-exports
 * this same type so existing daemon-layer imports are unaffected.
 */
export type OperatorVerticalMode = 'legacy' | 'native-v1';
