/**
 * Triage reality-check — CLI entry point (library form).
 *
 * Composes the gatherer and the classifier and emits the verdict as a
 * single JSON line. The thin shim in `bin/jinn-triage-check.ts` parses
 * argv and calls this function with the default runner.
 *
 * Exit semantics: this function rethrows on any gather/classify failure.
 * The shim translates a thrown exception into a non-zero exit code, so
 * the implement-issue skill can use `set -e` (or trap the exit) and abort
 * triage on failure — fail-loud per Step 1.5.
 */

import type { CommandRunner } from '../dispatcher/issue-source.js';
import { gatherRealityCheckSignals } from './gather.js';
import { classifyRealityCheck } from './reality-check.js';

export type Writer = (s: string) => void;

export async function runTriageCheck(
  issueNumber: number,
  runner: CommandRunner,
  write: Writer,
): Promise<void> {
  const input = await gatherRealityCheckSignals(issueNumber, runner);
  const verdict = classifyRealityCheck(input);
  // Emit a single line of JSON so the skill can `jq` it without buffering
  // weirdness. Newline terminator helps line-based consumers.
  write(`${JSON.stringify(verdict)}\n`);
}
