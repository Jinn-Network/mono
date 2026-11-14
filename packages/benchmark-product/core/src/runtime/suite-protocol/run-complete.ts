/** Post-collect suite completeness: Matrix cells + ATIF bytes on the retained Harbor job. */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountSuiteArmCells,
  allArmsRunComplete,
  assessArmRunComplete as assessArmRunCompleteInTree,
  atifOnRetainedJob as atifOnRetainedJobInTree,
  rewardJsonOnRetainedJob as rewardJsonOnRetainedJobInTree,
  type ArmRunComplete,
  type MatrixCellAccount,
  type SuiteEvidenceTree,
} from "@colophon-claims/check";
import type { SuiteProtocolSelection } from "./manifest.js";

// The predicates live in the checker, which re-derives `leaderboardSubmitReady` from the files a
// bundle declaring `suite-comparability` carries (issue #4762). This module hands them a tree read
// from the producing machine's disk, so `report` and the reader run one implementation.
export { accountSuiteArmCells, allArmsRunComplete };
export type { ArmRunComplete, MatrixCellAccount };

function listFiles(root: string, current = ""): string[] {
  const directory = current === "" ? root : join(root, current);
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch { return []; }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = current === "" ? entry.name : `${current}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/** A directory on the producing machine, read as an evidence tree. Symbolic links and anything
 * else that is not a regular file or directory are not part of it. */
export function suiteEvidenceTreeFromDirectory(root: string): SuiteEvidenceTree {
  let listed: readonly string[] | undefined;
  return {
    paths: () => (listed ??= listFiles(root)),
    read: (path) => {
      const absolute = join(root, ...path.split("/"));
      try {
        if (!lstatSync(absolute).isFile()) return undefined;
        return new Uint8Array(readFileSync(absolute));
      } catch {
        return undefined;
      }
    },
  };
}

export function atifOnRetainedJob(
  jobDir: string,
  suite: SuiteProtocolSelection,
  matrix: { readonly cells: readonly MatrixCellAccount[] },
  armId: string,
): boolean {
  return atifOnRetainedJobInTree(suiteEvidenceTreeFromDirectory(jobDir), suite, matrix, armId);
}

export function rewardJsonOnRetainedJob(
  jobDir: string,
  suite: SuiteProtocolSelection,
  matrix: { readonly cells: readonly MatrixCellAccount[] },
  armId: string,
): boolean {
  return rewardJsonOnRetainedJobInTree(suiteEvidenceTreeFromDirectory(jobDir), suite, matrix, armId);
}

export function assessArmRunComplete(input: {
  readonly matrix: { readonly cells: readonly MatrixCellAccount[] };
  readonly suite: SuiteProtocolSelection;
  readonly armId: string;
  readonly jobDir: string;
}): ArmRunComplete {
  return assessArmRunCompleteInTree({
    matrix: input.matrix,
    suite: input.suite,
    armId: input.armId,
    tree: suiteEvidenceTreeFromDirectory(input.jobDir),
  });
}
