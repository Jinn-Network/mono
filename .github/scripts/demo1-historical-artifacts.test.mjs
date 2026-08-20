import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * Byte pin for Demo-1's sealed pre-run artifacts.
 *
 * v2, the task evidence, and v3 are the historical record of Demo-1 stopping at the pre-run
 * content-supply boundary (PR #2687): zero model arms, zero Docker controls, zero cells. They
 * describe the OLD method — one `anthropics/skills` candidate against an unrelated SWE-rebench
 * slate — and DR-2026-08-16 supersedes that source decision without rewriting these bytes. v4 is
 * the current freeze on the SkillsBench source and is a STOP for a different, measured reason.
 *
 * `packages/benchmark-product/core/src/method/demo1-task-evidence.test.ts` already pins the three
 * historical digests and round-trips them through the real verifiers. That suite runs under
 * `.github/workflows/benchmark-product-ci.yml`, whose path filter covers package source and a
 * hand-listed set of docs — but NOT `docs/superpowers/plans/demo-report-1/`. A pull request that
 * edited only these artifacts therefore triggered no test at all. This file is the build-free
 * counterpart that runs on every pull request via `.github/workflows/repository-structure.yml`,
 * so the seal is checked even when no code path moves.
 */

const repoRoot = resolve(import.meta.dirname, '../..');
const artifactDir = join(repoRoot, 'docs/superpowers/plans/demo-report-1');

/** Exact sealed bytes. A published artifact is never edited; it is superseded by a new one. */
const SEALED_ARTIFACTS = [
  {
    file: 'E1-pre-run-freeze.stop.v2.json',
    schema: 'jinn.demo1.pre-run-freeze.v2',
    sha256: '08b7e7d0a17d8a4c1ff876111a2e0cb49056b3e5bfe313e8684f46d2b85ae58a',
  },
  {
    file: 'E1-task-evidence.v1.json',
    schema: 'jinn.demo1.task-evidence.v1',
    sha256: 'b136f80342e5d6e7179267590c72d6bcde9c6922ecd61841faf18905daada8e1',
  },
  {
    file: 'E1-pre-run-freeze.stop.v3.json',
    schema: 'jinn.demo1.pre-run-freeze.v3',
    sha256: 'd439e6729144a74c84f124c058a3c1e01e557091085b9e2c26740884e24b2f3c',
  },
  // The current freeze, on the SkillsBench source. Unlike v2 and v3 this one is still live: if the
  // admission logic changes, this digest SHOULD break, because the freeze has to be regenerated
  // and re-reviewed rather than silently drifting under the code that produced it. It is NOT named
  // `.stop.` — static admission passes, and the filename has to keep telling the truth.
  {
    file: 'E1-pre-run-freeze.v4.json',
    schema: 'jinn.demo1.pre-run-freeze.v4',
    sha256: '404b3c8ad00330a9ff09a7dbb415a44498173979ad965fe13bcf9ca659dc0ca0',
  },
];

/** Derived values the v3 freeze must keep, so a digest-preserving rebuild cannot drift them. */
const V3_SELECTION_BASIS_SHA256 = '0e3bae591902ee7efd38848ebeeee858dabbbc1efb2e5c9d86bbbce2bd80f1d3';
const V3_TASK_SELECTION_SEED = 486786042;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readArtifact(file) {
  return readFileSync(join(artifactDir, file));
}

for (const artifact of SEALED_ARTIFACTS) {
  test(`${artifact.file} bytes are unchanged`, () => {
    const bytes = readArtifact(artifact.file);
    assert.equal(
      sha256(bytes),
      artifact.sha256,
      `${artifact.file} changed; Demo-1's sealed pre-run evidence is never edited, it is superseded by a new versioned artifact`,
    );
  });

  test(`${artifact.file} still parses and declares ${artifact.schema}`, () => {
    const parsed = JSON.parse(readArtifact(artifact.file).toString('utf8'));
    assert.equal(parsed.schema, artifact.schema);
  });
}

test('the v2 and v3 freezes both record a STOP with no winner', () => {
  for (const file of ['E1-pre-run-freeze.stop.v2.json', 'E1-pre-run-freeze.stop.v3.json']) {
    const parsed = JSON.parse(readArtifact(file).toString('utf8'));
    assert.equal(parsed.derived.status, 'stop', `${file} must remain a STOP`);
    assert.equal(parsed.derived.winner, null, `${file} must name no winner`);
    assert.ok(parsed.derived.stopReasons.length > 0, `${file} must keep its stop reasons`);
  }
});

test('v4 passes static admission but authorizes only the no-model controls', () => {
  // The load-bearing distinction. Static capacity clearing the floor authorizes the oracle and
  // no-op controls; it is not permission to spend inference. Collapsing the two is how a screening
  // step silently becomes a green light.
  const v4 = JSON.parse(readArtifact('E1-pre-run-freeze.v4.json').toString('utf8'));
  assert.equal(v4.derived.status, 'ready');
  assert.equal(v4.derived.authorizes, 'dynamic-controls');
  assert.equal(v4.derived.dynamicEvidence.withOracleEvidence, 0);
  assert.equal(v4.derived.dynamicEvidence.withNoOpEvidence, 0);
});

test('every artifact accounts zero model execution', () => {
  for (const artifact of SEALED_ARTIFACTS) {
    const { execution } = JSON.parse(readArtifact(artifact.file).toString('utf8'));
    assert.equal(execution.modelArms, 0, `${artifact.file} modelArms`);
    assert.equal(execution.previews, 0, `${artifact.file} previews`);
  }
  for (const file of ['E1-pre-run-freeze.stop.v2.json', 'E1-pre-run-freeze.stop.v3.json', 'E1-pre-run-freeze.v4.json']) {
    const { execution } = JSON.parse(readArtifact(file).toString('utf8'));
    assert.equal(execution.rehearsalCells, 0, `${file} rehearsalCells`);
    assert.equal(execution.officialCells, 0, `${file} officialCells`);
  }
});

test('v4 supersedes the exact v3 bytes, continuing the v2 <- v3 <- v4 chain', () => {
  const v4 = JSON.parse(readArtifact('E1-pre-run-freeze.v4.json').toString('utf8'));
  assert.equal(v4.inputs.supersedes.schema, 'jinn.demo1.pre-run-freeze.v3');
  assert.equal(
    v4.inputs.supersedes.sha256,
    sha256(readArtifact('E1-pre-run-freeze.stop.v3.json')),
    'v4 must supersede the exact on-disk v3 bytes',
  );
  assert.equal(v4.inputs.source.commit, 'b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af');
  assert.equal(v4.derived.capacity.requiredUnits, 21);
  assert.equal(v4.derived.capacity.requiredClusters, 13);
});

test('v3 supersedes the exact v2 bytes and keeps its derived selection basis', () => {
  const v3 = JSON.parse(readArtifact('E1-pre-run-freeze.stop.v3.json').toString('utf8'));
  assert.equal(v3.inputs.supersedes.schema, 'jinn.demo1.pre-run-freeze.v2');
  assert.equal(
    v3.inputs.supersedes.sha256,
    sha256(readArtifact('E1-pre-run-freeze.stop.v2.json')),
    'v3 must supersede the exact on-disk v2 bytes',
  );
  assert.equal(v3.derived.taskEvidenceSha256, sha256(readArtifact('E1-task-evidence.v1.json')));
  assert.equal(v3.derived.selectionBasisSha256, V3_SELECTION_BASIS_SHA256);
  assert.equal(v3.derived.seeds.taskSelection, V3_TASK_SELECTION_SEED);
});

test('v3 binds the pinned anthropics/skills source it was frozen against', () => {
  const { source } = JSON.parse(
    readArtifact('E1-pre-run-freeze.stop.v3.json').toString('utf8'),
  ).inputs.method;
  assert.equal(source.repositoryUrl, 'https://github.com/anthropics/skills.git');
  assert.equal(source.commit, 'f17010c9bb483898c1d9c9f42dde2b3a98889434');
});

test('E1-pre-run-freeze.md still publishes every sealed digest', () => {
  const prose = readFileSync(join(artifactDir, 'E1-pre-run-freeze.md'), 'utf8');
  for (const artifact of SEALED_ARTIFACTS) {
    assert.ok(
      prose.includes(artifact.sha256),
      `E1-pre-run-freeze.md no longer publishes ${artifact.file}'s digest ${artifact.sha256}`,
    );
  }
});

test('the sealed artifacts are covered by a CI path filter', () => {
  // The gap this file exists to close: if no workflow watches the artifact directory, the
  // package-side verifier round-trips never fire on a docs-only edit.
  const workflow = readFileSync(
    join(repoRoot, '.github/workflows/benchmark-product-ci.yml'),
    'utf8',
  );
  const watched = workflow.match(/docs\/superpowers\/plans\/demo-report-1/gu) ?? [];
  assert.equal(
    watched.length,
    2,
    'benchmark-product-ci.yml must watch docs/superpowers/plans/demo-report-1/** on both pull_request and push, so the package-side verifiers run when the sealed artifacts are touched',
  );
});
