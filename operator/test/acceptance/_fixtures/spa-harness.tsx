/**
 * SPA harness for the cold-start-builder E2E (r83r Task 9).
 *
 * Stage 6 deleted the daemon-served SPA, including Build.tsx. The harness
 * always skips; the rest of the cold-start loop (CLI pack/publish/indexer)
 * still runs.
 */
export interface SkippedHarness {
  skipped: true;
  reason: string;
}

export type SpaHarnessResult = SkippedHarness;

export async function renderBuildPage(): Promise<SpaHarnessResult> {
  return {
    skipped: true,
    reason: 'operator SPA departed at Stage 6; Build.tsx is gone.',
  };
}
