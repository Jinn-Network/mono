import { RequesterError, isRequesterError } from '../errors.js';

/**
 * Ordered preflight categories. The order is the fail-fast order: cheap local checks precede
 * network reads, and document sealing runs last because it is only meaningful once the target
 * and its terms are fixed. Mirrors the legacy
 * `MARKETPLACE_TASK_SUBMIT_PREFLIGHT_CATEGORIES` (creator|funds|rpc|contracts|indexer|gateway|
 * solverNet) re-derived onto the work-client category set (config|funds|venue|target|freshness|
 * documents), pinned by the golden fixture.
 */
export const POSTING_PREFLIGHT_CATEGORIES = [
  'config',
  'funds',
  'venue',
  'target',
  'freshness',
  'documents',
] as const;

export type PostingPreflightCategory = (typeof POSTING_PREFLIGHT_CATEGORIES)[number];

export type PostingPreflightChecks = Record<PostingPreflightCategory, () => Promise<void>>;

export interface PostingPreflightEntry {
  readonly category: PostingPreflightCategory;
  readonly status: 'ok' | 'failed';
  readonly code?: string;
  readonly detail?: string;
}

export class PostingPreflightFailure extends RequesterError {
  constructor(
    category: PostingPreflightCategory,
    code: string,
    detail: string,
    readonly report: readonly PostingPreflightEntry[],
    options?: { cause?: unknown },
  ) {
    super(category, code, `posting preflight failed (${category}/${code}): ${detail}`, options);
  }
}

export async function runPostingPreflight(
  checks: PostingPreflightChecks,
): Promise<readonly PostingPreflightEntry[]> {
  const report: PostingPreflightEntry[] = [];
  for (const category of POSTING_PREFLIGHT_CATEGORIES) {
    try {
      // eslint-disable-next-line no-await-in-loop -- preflight is deliberately sequential.
      await checks[category]();
      report.push({ category, status: 'ok' });
    } catch (err) {
      const code = isRequesterError(err) ? err.code : 'check-threw';
      const detail = err instanceof Error ? err.message : String(err);
      report.push({ category, status: 'failed', code, detail });
      throw new PostingPreflightFailure(category, code, detail, report, { cause: err });
    }
  }
  return report;
}
