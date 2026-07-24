import type { CommandRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import { gitOid, type GitOid } from './types.js';

export const GITHUB_CHANGED_FILES_MAX = 3_000;

export interface ExactChangedFiles {
  readonly baseOid: GitOid;
  readonly files: readonly string[];
  readonly complete: boolean;
}

export interface ReadExactChangedFilesOptions {
  readonly run: CommandRunner;
  readonly prNumber: number;
  readonly expectedHead: GitOid;
  readonly expectedBaseRefName: string;
  readonly context: string;
  readonly readFiles?: (prNumber: number) => Promise<readonly string[]>;
}

function filenames(raw: unknown, context: string): string[] {
  if (
    !Array.isArray(raw)
    || !raw.every((page) => Array.isArray(page))
  ) {
    throw new Error(`${context} changed-file read was incomplete`);
  }
  return (raw as Array<Array<{ filename?: unknown }>>).flat().map((file) => {
    if (typeof file.filename !== 'string') {
      throw new Error(`Malformed ${context.toLowerCase()} changed file`);
    }
    return file.filename;
  });
}

/**
 * Bind changed-file policy to the exact REST head/base snapshot. GitHub caps
 * this endpoint at 3,000 files, so pagination alone is never completeness
 * proof.
 */
export async function readExactChangedFiles(
  options: ReadExactChangedFilesOptions,
): Promise<ExactChangedFiles> {
  const metadata = JSON.parse(await options.run('gh', [
    'api', `repos/${REPO}/pulls/${options.prNumber}`,
  ])) as {
    changed_files?: unknown;
    head?: { sha?: unknown };
    base?: { ref?: unknown; sha?: unknown };
  };
  if (
    metadata.head?.sha !== options.expectedHead
    || metadata.base?.ref !== options.expectedBaseRefName
    || typeof metadata.base.sha !== 'string'
    || typeof metadata.changed_files !== 'number'
    || !Number.isSafeInteger(metadata.changed_files)
    || metadata.changed_files < 0
  ) {
    throw new Error(
      `${options.context} changed-file metadata lost exact PR authority`,
    );
  }
  const files = options.readFiles === undefined
    ? filenames(JSON.parse(await options.run('gh', [
      'api',
      `repos/${REPO}/pulls/${options.prNumber}/files?per_page=100`,
      '--paginate',
      '--slurp',
    ])), options.context)
    : [...await options.readFiles(options.prNumber)];
  if (!files.every((file) => typeof file === 'string')) {
    throw new Error(`Malformed ${options.context.toLowerCase()} changed file`);
  }
  return {
    baseOid: gitOid(metadata.base.sha),
    files,
    complete: metadata.changed_files <= GITHUB_CHANGED_FILES_MAX
      && files.length === metadata.changed_files
      && new Set(files).size === files.length,
  };
}
