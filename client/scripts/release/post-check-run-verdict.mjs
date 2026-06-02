#!/usr/bin/env node
/**
 * Shared check-run poster for the two-gate release pipeline.
 *
 * Per docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md §7
 * ("Evidence flow — verify, don't re-run") and #923, the release pipeline records
 * each gate's verdict as a GitHub check-run bound to the commit SHA — the native
 * primitive branch protection and the publish guard reason about. A rebase changes
 * the SHA, so a stale verdict simply doesn't apply (automatic invalidation).
 *
 * This single poster is used by BOTH gate workflows:
 *   - .github/workflows/hermetic-gate.yml      (context: "hermetic-gate")
 *   - .github/workflows/environment-suite.yml  (context: "environment-suite")
 *
 * Invocation:
 *   node post-check-run-verdict.mjs <verdict.json>
 *
 * The verdict JSON shape (locked across all step agents):
 *   {
 *     "context":    "hermetic-gate" | "environment-suite",
 *     "headSha":    "<40-char sha>",
 *     "conclusion": "success" | "failure" | "neutral",
 *     "scenarios": [
 *       { "id": string, "verdict": "pass"|"fail"|"skip", "failClass": string|null, "notes": string|null }
 *     ],
 *     "summary":    string
 *   }
 *
 * Posts a completed check-run via `gh api -X POST repos/{owner}/{repo}/check-runs`,
 * with name=context, head_sha=headSha, status=completed, the given conclusion, and a
 * readable output.title/summary. owner/repo are read from GITHUB_REPOSITORY.
 *
 * Fails LOUD on any missing/malformed field — a bad verdict must never silently
 * post a misleading green.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const VALID_CONTEXTS = ['hermetic-gate', 'environment-suite'];
const VALID_CONCLUSIONS = ['success', 'failure', 'neutral'];
const VALID_VERDICTS = ['pass', 'fail', 'skip'];

function fail(message) {
  console.error(`post-check-run-verdict: ${message}`);
  process.exit(1);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function loadVerdict(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    fail(`could not read verdict file ${path}: ${err?.message ?? String(err)}`);
  }
  let verdict;
  try {
    verdict = JSON.parse(raw);
  } catch (err) {
    fail(`verdict file ${path} is not valid JSON: ${err?.message ?? String(err)}`);
  }
  if (verdict === null || typeof verdict !== 'object' || Array.isArray(verdict)) {
    fail(`verdict file ${path} must contain a JSON object`);
  }
  return verdict;
}

function validateVerdict(verdict, path) {
  const errors = [];

  if (!isNonEmptyString(verdict.context)) {
    errors.push('missing "context" (string)');
  } else if (!VALID_CONTEXTS.includes(verdict.context)) {
    errors.push(`"context" must be one of ${VALID_CONTEXTS.join(' | ')} (got ${JSON.stringify(verdict.context)})`);
  }

  if (!isNonEmptyString(verdict.headSha)) {
    errors.push('missing "headSha" (string)');
  } else if (!/^[0-9a-f]{40}$/.test(verdict.headSha)) {
    errors.push(`"headSha" must be a 40-char lowercase hex SHA (got ${JSON.stringify(verdict.headSha)})`);
  }

  if (!isNonEmptyString(verdict.conclusion)) {
    errors.push('missing "conclusion" (string)');
  } else if (!VALID_CONCLUSIONS.includes(verdict.conclusion)) {
    errors.push(`"conclusion" must be one of ${VALID_CONCLUSIONS.join(' | ')} (got ${JSON.stringify(verdict.conclusion)})`);
  }

  if (!isNonEmptyString(verdict.summary)) {
    errors.push('missing "summary" (string)');
  }

  if (!Array.isArray(verdict.scenarios)) {
    errors.push('missing "scenarios" (array)');
  } else {
    verdict.scenarios.forEach((scenario, idx) => {
      if (scenario === null || typeof scenario !== 'object' || Array.isArray(scenario)) {
        errors.push(`scenarios[${idx}] must be an object`);
        return;
      }
      if (!isNonEmptyString(scenario.id)) {
        errors.push(`scenarios[${idx}].id must be a non-empty string`);
      }
      if (!VALID_VERDICTS.includes(scenario.verdict)) {
        errors.push(
          `scenarios[${idx}].verdict must be one of ${VALID_VERDICTS.join(' | ')} (got ${JSON.stringify(scenario.verdict)})`,
        );
      }
      // failClass / notes are nullable strings — present-but-wrong-type is an error.
      if (scenario.failClass !== null && typeof scenario.failClass !== 'string') {
        errors.push(`scenarios[${idx}].failClass must be a string or null`);
      }
      if (scenario.notes !== null && typeof scenario.notes !== 'string') {
        errors.push(`scenarios[${idx}].notes must be a string or null`);
      }
    });
  }

  if (errors.length > 0) {
    console.error(`post-check-run-verdict: verdict file ${path} is invalid:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

function renderSummary(verdict) {
  const lines = [];
  lines.push(verdict.summary);
  lines.push('');
  lines.push('| Scenario | Verdict | Fail class | Notes |');
  lines.push('| --- | --- | --- | --- |');
  if (verdict.scenarios.length === 0) {
    lines.push('| _(no scenarios reported)_ | | | |');
  } else {
    for (const s of verdict.scenarios) {
      const failClass = s.failClass ?? '';
      const notes = (s.notes ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| \`${s.id}\` | ${s.verdict} | ${failClass} | ${notes} |`);
    }
  }
  lines.push('');
  lines.push(`Bound to head_sha \`${verdict.headSha}\`.`);
  return lines.join('\n');
}

function main() {
  const [, , verdictPath] = process.argv;
  if (!verdictPath) {
    fail('usage: node post-check-run-verdict.mjs <verdict.json>');
  }

  const repo = process.env.GITHUB_REPOSITORY;
  if (!isNonEmptyString(repo) || !repo.includes('/')) {
    fail('GITHUB_REPOSITORY must be set as "<owner>/<repo>"');
  }
  const [owner, repoName] = repo.split('/');

  const verdict = loadVerdict(verdictPath);
  validateVerdict(verdict, verdictPath);

  const failCount = verdict.scenarios.filter((s) => s.verdict === 'fail').length;
  const title =
    verdict.conclusion === 'success'
      ? `${verdict.context}: ${verdict.scenarios.length} scenario(s) passed`
      : `${verdict.context}: ${verdict.conclusion} (${failCount} failing)`;

  // Build the check-run payload. `gh api` accepts a JSON body on stdin via
  // `--input -`, which avoids per-field --raw-field quoting and lets us pass the
  // nested `output` object cleanly.
  const payload = {
    name: verdict.context,
    head_sha: verdict.headSha,
    status: 'completed',
    conclusion: verdict.conclusion,
    output: {
      title,
      summary: renderSummary(verdict),
    },
  };

  const args = [
    'api',
    '-X',
    'POST',
    `repos/${owner}/${repoName}/check-runs`,
    '-H',
    'Accept: application/vnd.github+json',
    '--input',
    '-',
  ];

  const result = spawnSync('gh', args, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  if (result.error) {
    fail(`failed to invoke gh: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`gh api exited ${result.status} while posting the ${verdict.context} check-run on ${verdict.headSha}`);
  }

  console.log(
    `post-check-run-verdict: posted ${verdict.context}=${verdict.conclusion} on ${owner}/${repoName}@${verdict.headSha}`,
  );
}

main();
