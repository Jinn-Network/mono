import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflowRoot = resolve(import.meta.dirname, '../workflows');

test('PR architecture workflow exposes exact required job checks and gates reusable verification', () => {
  const source = readFileSync(resolve(workflowRoot, 'platform-architecture-control.yml'), 'utf8');
  assert.match(source, /pull_request:/u);
  assert.doesNotMatch(source, /pull_request_target:/u);
  // Both required contexts this workflow reports (`platform-architecture-control` and
  // `platform-verification`) have to report on merge groups too, or a queue entry sits
  // on unreported checks until the check-response timeout ejects it (DR-2026-08-18-b D3).
  // The trigger set is pinned exactly so neither the merge-group lane nor the absence of
  // `pull_request_target` can drift back out.
  const triggers = source.match(/^on:\n(?<body>[\s\S]*?)\n\n/mu)?.groups?.body;
  assert.equal(triggers, '  pull_request:\n  merge_group:\n  workflow_dispatch:');
  assert.match(source, /platform-architecture-control:\n\s+name: platform-architecture-control/u);
  assert.match(source, /platform-verification:\n\s+name: platform-verification\n\s+needs:\n\s+- verification-selection\n\s+- platform-verification-reusable/u);
  assert.match(source, /uses: \.\/\.github\/workflows\/platform-verification\.yml/u);
  assert.match(source, /github\.event\.pull_request\.head\.sha/u);
  assert.match(source, /lane: canary/u);
  assert.match(source, /VERIFICATION_RESULT: \$\{\{ needs\.platform-verification-reusable\.result \}\}/u);
  assert.match(source, /test "\$\{VERIFICATION_RESULT\}" = success/u);
  // The reusable call is gated on the changed-package closure. The final gate still
  // demands exact success when verification is selected, and exact `skipped` when it
  // is not — so unselection can never launder a failed or cancelled run.
  assert.match(source, /node \.github\/scripts\/platform-verification-selection\.mjs/u);
  assert.match(source, /needs: verification-selection\n\s+if: needs\.verification-selection\.outputs\.run == 'true'/u);
  assert.match(source, /test "\$\{SELECTION_RESULT\}" = success/u);
  assert.match(source, /test "\$\{VERIFICATION_RESULT\}" = skipped/u);
  // Selection is diff-driven on both lanes: the pull_request branch keeps the base/head
  // pair it has always used, and the merge_group branch reads the equivalent pair off the
  // merge-group payload so a narrow queue entry stops paying the full battery. Any other
  // event still verifies in full. The three-dot diff needs unshallow history on both.
  const selectionJob = source.slice(
    source.indexOf('  verification-selection:'),
    source.indexOf('  platform-release-surface:'),
  );
  assert.match(selectionJob, /fetch-depth: 0/u);
  assert.match(selectionJob, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
  assert.match(selectionJob, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.match(selectionJob, /MG_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/u);
  assert.match(selectionJob, /MG_HEAD_SHA: \$\{\{ github\.event\.merge_group\.head_sha \}\}/u);
  assert.match(selectionJob, /^\s+pull_request\)\n\s+diff_base="\$\{BASE_SHA\}"\n\s+diff_head="\$\{HEAD_SHA\}"/mu);
  assert.match(selectionJob, /^\s+merge_group\)\n\s+diff_base="\$\{MG_BASE_SHA\}"\n\s+diff_head="\$\{MG_HEAD_SHA\}"/mu);
  assert.match(selectionJob, /git diff --name-only "\$\{diff_base\}\.\.\.\$\{diff_head\}"/u);
  assert.match(selectionJob, /non-PR, non-merge-group event verifies in full/u);
  assert.doesNotMatch(source, /npm (?:publish|install)|yarn npm publish|publish-verified-platform/u);
  const topPermissions = source.match(/^permissions:\n(?<body>[\s\S]*?)\njobs:/mu)?.groups?.body;
  assert.equal(topPermissions?.trimEnd(), '  contents: read');
  const controlJob = source.slice(
    source.indexOf('  platform-architecture-control:'),
    source.indexOf('  platform-verification-reusable:'),
  );
  const reusableJob = source.slice(
    source.indexOf('  platform-verification-reusable:'),
    source.indexOf('  platform-verification:'),
  );
  const finalJob = source.slice(source.indexOf('  platform-verification:'));
  assert.doesNotMatch(controlJob, /(?:id-token|attestations|artifact-metadata): write/u);
  assert.match(controlJob, /node \.github\/scripts\/generate-architecture\.mjs --check/u);
  assert.match(controlJob, /\.github\/scripts\/benchmark-product-source-boundaries\.test\.mjs/u);
  assert.match(reusableJob, /permissions:\n\s+contents: read\n\s+id-token: write\n\s+attestations: write\n\s+artifact-metadata: write/u);
  assert.doesNotMatch(finalJob, /(?:id-token|attestations|artifact-metadata): write/u);
});

test('scheduled/manual audit is read-only, summarizes, and uploads deterministic evidence', () => {
  const source = readFileSync(resolve(workflowRoot, 'architecture-policy-audit.yml'), 'utf8');
  assert.match(source, /schedule:/u);
  assert.match(source, /workflow_dispatch:/u);
  assert.match(source, /contents: read/u);
  assert.match(source, /branch-protection-audit\.mjs/u);
  assert.match(source, /GITHUB_STEP_SUMMARY/u);
  assert.match(source, /actions\/upload-artifact@/u);
  assert.doesNotMatch(source, /\b(?:POST|PUT|PATCH|DELETE)\b/u);
});
