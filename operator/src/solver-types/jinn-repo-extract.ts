export interface PrSummary {
  number: number;
  files: string[];
  closingIssues: number[];
}

const TEST_PATH = /(^|\/)(?:operator|client)\/test\/.+\.test\.ts$/;

export function selectCandidatePRs(prs: PrSummary[]): PrSummary[] {
  return prs.filter(
    (pr) => pr.closingIssues.length > 0 && pr.files.some((f) => TEST_PATH.test(f)),
  );
}

import { JinnRepoPoolItemSchema, type JinnRepoPoolItem } from './_jinn-repo-pool.js';

export interface ExtractDeps {
  exec: (cmd: string, args: string[]) => Promise<string>;
  fetchIssue: (n: number) => Promise<{ title: string; body: string }>;
  mergeCommit: string;
}

export async function extractPoolItem(pr: PrSummary, deps: ExtractDeps): Promise<JinnRepoPoolItem> {
  const base = (await deps.exec('git', ['rev-parse', `${deps.mergeCommit}^1`])).trim();
  const testFiles = pr.files.filter((f) => TEST_PATH.test(f));
  const gold_tests: Record<string, string> = {};
  for (const f of testFiles) {
    gold_tests[f] = await deps.exec('git', ['show', `${deps.mergeCommit}:${f}`]);
  }
  const solution_patch = await deps.exec('git', [
    'diff', base, deps.mergeCommit, '--', '.', ':(exclude)operator/test/**', ':(exclude)client/test/**',
  ]);
  const issue = await deps.fetchIssue(pr.closingIssues[0]!);
  const item: JinnRepoPoolItem = {
    schemaVersion: 'jinn-repo.v1',
    source: 'merged-pr',
    instance_id: `Jinn-Network__mono-${pr.number}`,
    repo: 'Jinn-Network/mono',
    base_commit: base,
    merged_pr: pr.number,
    language: 'typescript',
    problem_statement: `${issue.title}\n\n${issue.body}`.trim(),
    test_files: testFiles,
    test_cmd: `yarn vitest run ${testFiles.join(' ')}`,
    gold_tests,
    solution_patch,
  };
  return JinnRepoPoolItemSchema.parse(item);
}
