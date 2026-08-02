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
  assert.match(source, /platform-verification:\n\s+name: platform-verification\n\s+needs:\s+platform-verification-reusable/u);
  assert.match(source, /uses: \.\/\.github\/workflows\/platform-verification\.yml/u);
  assert.match(source, /github\.event\.pull_request\.head\.sha/u);
  assert.match(source, /lane: canary/u);
  assert.match(source, /VERIFICATION_RESULT: \$\{\{ needs\.platform-verification-reusable\.result \}\}/u);
  assert.match(source, /test "\$\{VERIFICATION_RESULT\}" = success/u);
  assert.doesNotMatch(source, /npm (?:publish|install)|yarn npm publish|publish-verified-platform/u);
  assert.match(source, /attestations: write/u);
  assert.match(source, /id-token: write/u);
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
