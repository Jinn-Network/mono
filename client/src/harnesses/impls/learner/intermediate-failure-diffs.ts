/**
 * intermediateFailureDiffs capture helpers (#2225).
 *
 * Ports jinn-agent session_bridge._is_test_command + accepted_diff semantics
 * into a shared TypeScript module used by the learner PostToolUseFailure hook
 * and harvestOutput attach path.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const JINN_CAPTURE_DIR = '.jinn';
export const SESSION_REPO_BASE_HEAD_FILE = '.jinn/session-repo-base-head';
export const INTERMEDIATE_FAILURE_DIFFS_FILE = '.jinn/intermediate-failure-diffs.json';

const TEST_EXECUTABLES = new Set(['pytest', 'tox', 'jest', 'vitest']);
const PACKAGE_MANAGERS = new Set(['yarn', 'npm', 'pnpm', 'bun', 'cargo', 'go', 'make']);

/**
 * Minimal shlex.split-compatible argv splitter for the command-gate table.
 * Throws (ValueError equivalent) on unparseable quoting.
 */
function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote === "'" ) {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (quote !== null || escaped) {
    throw new Error('unparseable shell quoting');
  }
  if (current.length > 0) {
    words.push(current);
  }
  return words;
}

/**
 * Port of apps/jinn-agent/plugins/jinn/session_bridge.py `_is_test_command`.
 */
export function isTestCommand(command: string): boolean {
  let words: string[];
  try {
    words = splitShellWords(command);
  } catch {
    return false;
  }
  if (words.length === 0) return false;

  const first = basename(words[0]!);
  if (TEST_EXECUTABLES.has(first) || first === 'run_tests.sh') return true;
  if (words.some((word) => basename(word) === 'run_tests.sh')) return true;
  return words.length >= 2 && PACKAGE_MANAGERS.has(first) && words[1] === 'test';
}

function gitStdout(
  repoDir: string,
  args: string[],
  acceptedCodes: readonly number[] = [0],
): string {
  try {
    return execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer };
    const status = typeof e.status === 'number' ? e.status : -1;
    if (acceptedCodes.includes(status)) {
      return typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf8') ?? '';
    }
    throw err;
  }
}

/**
 * Port of session_bridge.accepted_diff — tracked + untracked patch vs base HEAD.
 * Never mutates the git index.
 */
export function workingTreeDiff(repoDir: string, baseHead: string): string {
  const tracked = gitStdout(
    repoDir,
    ['-c', 'core.quotepath=false', 'diff', '--binary', '--no-ext-diff', baseHead, '--'],
    [0, 1],
  );
  const untrackedRaw = gitStdout(
    repoDir,
    ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '-z'],
  );
  const pieces: string[] = [];
  if (tracked) pieces.push(tracked);
  for (const name of untrackedRaw.split('\0')) {
    if (!name) continue;
    const patch = gitStdout(
      repoDir,
      ['-c', 'core.quotepath=false', 'diff', '--no-index', '--binary', '--', '/dev/null', name],
      [0, 1],
    );
    if (patch) pieces.push(patch);
  }
  return pieces.join('');
}

function readStoreArray(storePath: string): string[] {
  if (!existsSync(storePath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== 'string' || !item) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

export function appendIntermediateFailureDiff(storePath: string, diff: string): void {
  if (!diff) return;
  mkdirSync(dirname(storePath), { recursive: true });
  const existing = readStoreArray(storePath);
  if (existing.includes(diff)) return;
  existing.push(diff);
  const tmp = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(existing)}\n`);
  renameSync(tmp, storePath);
}

export function readIntermediateFailureDiffs(workingDir: string): string[] {
  return readStoreArray(join(workingDir, INTERMEDIATE_FAILURE_DIFFS_FILE));
}

export function attachIntermediateFailureDiffs<T extends { intermediateFailureDiffs?: string[] }>(
  solution: T,
  workingDir: string,
): T {
  const diffs = readIntermediateFailureDiffs(workingDir);
  if (diffs.length === 0) return solution;
  return { ...solution, intermediateFailureDiffs: diffs };
}

/**
 * PostToolUseFailure processing — implemented in Task 3.
 * Exported here so the hook CLI entry can live in this module.
 */
export function processPostToolUseFailure(stdinJson: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const workingDir = env.WORKING_DIR || env.JINN_WORKING_DIR;
    if (!workingDir) return;
    const event = JSON.parse(stdinJson) as {
      tool_name?: unknown;
      tool_input?: { command?: unknown };
    };
    if (event.tool_name !== 'Bash') return;
    const command = event.tool_input?.command;
    if (typeof command !== 'string' || !isTestCommand(command)) return;
    const basePath = join(workingDir, SESSION_REPO_BASE_HEAD_FILE);
    if (!existsSync(basePath)) return;
    const baseHead = readFileSync(basePath, 'utf8').trim();
    if (!baseHead) return;
    const repoDir = join(workingDir, 'repo');
    if (!existsSync(join(repoDir, '.git'))) return;
    const diff = workingTreeDiff(repoDir, baseHead);
    appendIntermediateFailureDiff(join(workingDir, INTERMEDIATE_FAILURE_DIFFS_FILE), diff);
  } catch (err) {
    console.error(
      `[intermediate-failure-diffs] processPostToolUseFailure: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'post-tool-use-failure') {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    processPostToolUseFailure(Buffer.concat(chunks).toString('utf8'), process.env);
    return;
  }
  if (cmd === 'record-base-head') {
    const workingDir = process.env.WORKING_DIR || process.env.JINN_WORKING_DIR;
    if (!workingDir) return;
    const repoDir = join(workingDir, 'repo');
    if (!existsSync(join(repoDir, '.git'))) return;
    try {
      const head = gitStdout(repoDir, ['rev-parse', 'HEAD']).trim();
      if (!head) return;
      mkdirSync(join(workingDir, JINN_CAPTURE_DIR), { recursive: true });
      writeFileSync(join(workingDir, SESSION_REPO_BASE_HEAD_FILE), `${head}\n`);
    } catch (err) {
      console.error(
        `[intermediate-failure-diffs] record-base-head: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  console.error(`unknown command: ${cmd ?? '(none)'}`);
  process.exitCode = 1;
}

const isDirect = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (isDirect) {
  void main();
}
