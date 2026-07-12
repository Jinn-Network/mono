#!/usr/bin/env tsx
/**
 * jinn-run-stage — CLI shim invoked by the implement-issue coordinator for the
 * depth-needing pipeline stages (Design / Implement / code-review / Independent
 * review). It runs a stage as a fresh `claude -p` ROOT session in the issue
 * worktree, so the stage's composed skill can fan out sub-agents at depth-1.
 *
 * Usage:
 *   jinn-run-stage --prompt-file <path> --worktree <path> [--model <m>] [--timeout-ms <n>]
 *
 * The coordinator writes the CURATED stage prompt (stage task + issue body/ACs
 * + prior-stage outputs) to <prompt-file> and passes it here. That file must
 * NOT include the headless-override block — `runStageHeadless` prepends it, so
 * embedding it in the file too would double-inject it.
 *
 * Streams the child's stdout to this process's stdout (the coordinator reads it
 * as the stage report) and forwards stderr; exits with the child's exit code
 * (non-zero on timeout).
 */

import { readFileSync } from 'node:fs';
import { runStageHeadless } from '../src/dispatcher/run-stage.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function requireFlag(name: string): string {
  const v = flag(name);
  if (v == null || v === '') {
    process.stderr.write(`jinn-run-stage: missing required flag ${name}\n`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const promptFile = requireFlag('--prompt-file');
  const worktree = requireFlag('--worktree');
  const model = flag('--model');
  const timeoutRaw = flag('--timeout-ms');
  const timeoutMs = timeoutRaw != null ? Number.parseInt(timeoutRaw, 10) : undefined;

  const stageTask = readFileSync(promptFile, 'utf8');

  const result = await runStageHeadless({
    stageTask,
    worktreePath: worktree,
    model,
    timeoutMs,
  });

  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.timedOut ? 1 : result.exitCode);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`jinn-run-stage: ${msg}\n`);
  process.exit(1);
});
