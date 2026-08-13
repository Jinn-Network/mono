import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflowRoot = resolve(import.meta.dirname, '../workflows');

test('PR architecture workflow exposes exact required job checks and gates reusable verification', () => {
  const source = readFileSync(resolve(workflowRoot, 'platform-architecture-control.yml'), 'utf8');
  assert.match(source, /pull_request:/u);
  assert.doesNotMatch(source, /pull_request_target:/u);
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
