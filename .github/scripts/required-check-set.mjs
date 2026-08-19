#!/usr/bin/env node

// The required status-check set for the `next` merge queue, as data.
//
// WHAT: the exact contexts branch protection requires on `next`, each paired
// with the workflow that reports it and how that report is produced. `kind`
// is `job` when GitHub derives the check name from a job's display `name:`,
// and `check-run` when the context is posted through the Checks API rather
// than being a job at all. `terminal: true` marks a member whose producing job
// collects every other job in its workflow (the `needs:`-everything gate
// shape); the enforcement test selects on that flag rather than on a `-gate`
// name suffix, so a terminal member named anything else still gets pinned.
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
  //
  // FORK LIMITATION, recorded here because neither DR-2026-08-18-b nor #2798
  // records it: the verdict job carries
  // `github.event.pull_request.head.repo.fork != true`, because a fork PR's
  // GITHUB_TOKEN is read-only whatever `checks: write` declares, so the
  // check-run POST would 403 and falsely redden the job. Once this context is
  // required, that carve-out means a fork PR never reports it and therefore can
  // never be enqueued. Intended handling: a maintainer re-runs the contribution
  // from a trusted in-repo branch, where the verdict posts normally.
  Object.freeze({
    context: 'hermetic-gate',
    workflow: 'hermetic-gate.yml',
    kind: 'check-run',
    terminal: true,
  }),
  Object.freeze({
    context: 'operator-ci-gate',
    workflow: 'ci.yml',
    kind: 'job',
    terminal: true,
  }),
  Object.freeze({
    context: 'console-ci-gate',
    workflow: 'operator-console-ci.yml',
    kind: 'job',
    terminal: true,
  }),
  Object.freeze({
    context: 'layer-ci-gate',
    workflow: 'layer-ci.yml',
    kind: 'job',
    terminal: true,
  }),
  Object.freeze({
    context: 'jinn-agent-gate',
    workflow: 'jinn-agent-ci.yml',
    kind: 'job',
    terminal: true,
  }),
  Object.freeze({
    context: 'repo-structure-gate',
    workflow: 'repository-structure.yml',
    kind: 'job',
    terminal: true,
  }),
  Object.freeze({
    context: 'stack-fixture-gate',
    workflow: 'stack-fixture-immutability.yml',
    kind: 'job',
    terminal: true,
  }),
  Object.freeze({
    context: 'canonical-docs-gate',
    workflow: 'canonical-docs-check.yml',
    kind: 'job',
    terminal: true,
  }),
]);

// WHAT IS DELIBERATELY NOT IN THE SET ABOVE (DR-2026-08-18-b D3,
// log/decisions/2026-08-18-merge-queue-on-next.md). These are reported today and
// admitted later; each carries a named condition rather than an intention.
//
//   - `Benchmark Product CI` — admitted once #2766 and #2782 close. The measured
//     ~10% full-battery flake in the sampled window is concentrated in those two.
//   - standalone `Task Execution CI` — admitted once its outlier runs (253
//     minutes observed) are bounded. Its *content* already rides the required
//     path: platform-verification's domain lanes run in full on every merge
//     group. What is deferred is the standalone context, not the coverage.
//   - `environment-suite` — permanently excluded, not deferred. It is a release
//     gate, and its global ref-independent concurrency group would serialize the
//     queue.
//
// ACCEPTED v1 COVERAGE GAPS (same ruling). Advisory on the PR lane and on push
// to `next` only, so breakage in them is landable through the queue. Named as
// gaps rather than claimed as covered; admission path is the same as above.
//
//   - `contracts/`
//   - `packages/indexer/**`
//   - `apps/website/`
//   - the benchmark-product surface

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
