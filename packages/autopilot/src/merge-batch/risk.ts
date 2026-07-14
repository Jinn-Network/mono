import type { MergeBatchPr, MergeBatchRisk } from './types.js';

const SOLO_PATHS = [
  '.github/workflows/',
  'client/package.json',
  'packages/autopilot/package.json',
  'packages/sdk/package.json',
  'contracts/',
];

export function classifyMergeBatchRisk(
  pr: Pick<MergeBatchPr, 'files' | 'additions' | 'deletions'>,
): MergeBatchRisk {
  if (
    pr.files.some((path) =>
      SOLO_PATHS.some((prefix) => path === prefix || path.startsWith(prefix)),
    )
  ) {
    return 'solo';
  }

  if (pr.files.length >= 20) return 'large';
  if (pr.additions + pr.deletions >= 800) return 'large';
  if (pr.files.length <= 2 && pr.additions + pr.deletions <= 50) return 'small';

  return 'normal';
}
