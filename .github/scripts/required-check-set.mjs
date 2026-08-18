#!/usr/bin/env node

// The required status-check set for the `next` merge queue, as data.
//
// WHAT: the exact contexts branch protection requires on `next`, each paired
// with the workflow that reports it and how that report is produced. `kind`
// is `job` when GitHub derives the check name from a job's display `name:`,
// and `check-run` when the context is posted through the Checks API rather
// than being a job at all.
//
// WHO CONSUMES IT:
//   - `required-check-set.test.mjs` (today) — proves every member is produced
//     by exactly one workflow, that nothing else in `.github/workflows/`
//     shadows a member's name, and that every producer reports on merge groups.
//   - `branch-protection-audit.mjs` and `enable-next-merge-queue.sh` (as the
//     remaining DR-2026-08-18-b step-0/step-1 layers land) — the audit reads
//     the contexts it must find on a protected branch, and the ruleset
//     mutation reads `--print-contexts` instead of restating the list.
//
// WHY DATA: on the GitHub side a required context is free text. A typo, or a
// gate job renamed without updating the ruleset, produces a required context
// that no workflow ever reports; a merge-group entry then sits on it until the
// check-response timeout ejects it (DR-2026-08-18-b D3/D6,
// log/decisions/2026-08-18-merge-queue-on-next.md). One source of truth plus
// one enforcement test makes that state unrepresentable.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_CHECK_SET = Object.freeze([
  Object.freeze({
    context: 'platform-architecture-control',
    workflow: 'platform-architecture-control.yml',
    kind: 'job',
  }),
  Object.freeze({
    context: 'platform-verification',
    workflow: 'platform-architecture-control.yml',
    kind: 'job',
  }),
  // Posted by operator/scripts/release/post-check-run-verdict.mjs from the
  // verdict JSON's `context` field. The job display names in that workflow are
  // deliberately different strings, so no job can shadow this context.
  Object.freeze({
    context: 'hermetic-gate',
    workflow: 'hermetic-gate.yml',
    kind: 'check-run',
  }),
  Object.freeze({
    context: 'operator-ci-gate',
    workflow: 'ci.yml',
    kind: 'job',
  }),
  Object.freeze({
    context: 'console-ci-gate',
    workflow: 'operator-console-ci.yml',
    kind: 'job',
  }),
  Object.freeze({
    context: 'layer-ci-gate',
    workflow: 'layer-ci.yml',
    kind: 'job',
  }),
  Object.freeze({
    context: 'jinn-agent-gate',
    workflow: 'jinn-agent-ci.yml',
    kind: 'job',
  }),
  Object.freeze({
    context: 'repo-structure-gate',
    workflow: 'repository-structure.yml',
    kind: 'job',
  }),
  Object.freeze({
    context: 'stack-fixture-gate',
    workflow: 'stack-fixture-immutability.yml',
    kind: 'job',
  }),
  Object.freeze({
    context: 'canonical-docs-gate',
    workflow: 'canonical-docs-check.yml',
    kind: 'job',
  }),
]);

export function requiredContexts() {
  return REQUIRED_CHECK_SET.map((member) => member.context).sort();
}

function parseArguments(argv) {
  if (argv.length !== 1 || argv[0] !== '--print-contexts') {
    throw new Error('usage: required-check-set.mjs --print-contexts');
  }
  return { printContexts: true };
}

function main() {
  parseArguments(process.argv.slice(2));
  process.stdout.write(`${requiredContexts().join('\n')}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`required check set: ${error.message}\n`);
    process.exitCode = 1;
  }
}
