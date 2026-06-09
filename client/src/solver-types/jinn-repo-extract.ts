export interface PrSummary {
  number: number;
  files: string[];
  closingIssues: number[];
}

const TEST_PATH = /(^|\/)client\/test\/.+\.test\.ts$/;

export function selectCandidatePRs(prs: PrSummary[]): PrSummary[] {
  return prs.filter(
    (pr) => pr.closingIssues.length > 0 && pr.files.some((f) => TEST_PATH.test(f)),
  );
}
