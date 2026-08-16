import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * Byte pin for Demo-1's sealed pre-run artifacts.
 *
 * These three files are the historical evidence that Demo-1 stopped at the pre-run content-supply
 * boundary (PR #2687): zero model arms, zero Docker controls, zero cells. They record the OLD
 * method — one `anthropics/skills` candidate against an unrelated SWE-rebench slate — and a later
 * source-method amendment supersedes that decision without rewriting these bytes.
 *
 * `packages/benchmark-product/core/src/method/demo1-task-evidence.test.ts` already pins the same
 * three digests and round-trips them through the real verifiers. That suite runs under
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

test('every artifact accounts zero model execution', () => {
  for (const artifact of SEALED_ARTIFACTS) {
    const { execution } = JSON.parse(readArtifact(artifact.file).toString('utf8'));
    assert.equal(execution.modelArms, 0, `${artifact.file} modelArms`);
    assert.equal(execution.previews, 0, `${artifact.file} previews`);
  }
  for (const file of ['E1-pre-run-freeze.stop.v2.json', 'E1-pre-run-freeze.stop.v3.json']) {
    const { execution } = JSON.parse(readArtifact(file).toString('utf8'));
    assert.equal(execution.rehearsalCells, 0, `${file} rehearsalCells`);
    assert.equal(execution.officialCells, 0, `${file} officialCells`);
  }
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

test('E1-pre-run-freeze.md still publishes the same three digests', () => {
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
