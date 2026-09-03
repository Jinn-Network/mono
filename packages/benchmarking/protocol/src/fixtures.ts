// SPDX-License-Identifier: Apache-2.0

/**
 * Loaders for the pinned tier-2 golden fixtures (issue #3341), in the shape
 * `packages/benchmarking/records/src/fixtures.ts` established: one directory per record kind,
 * `valid.json` carrying the exact canonical bytes and `valid.sha256` carrying the pinned digest.
 *
 * Regenerate with `yarn generate:fixtures`; see this package's README.
 */

import { readFile } from "node:fs/promises";

import type { GoldenRecordKind } from "./golden-documents.js";

function fixtureUrl(relativePath: string): URL {
  return new URL(`../fixtures/${relativePath}`, import.meta.url);
}

/** The exact stored bytes -- never re-canonicalized, so a serialization change is visible. */
export async function loadGoldenRecordBytes(kind: GoldenRecordKind): Promise<Uint8Array> {
  return new Uint8Array(await readFile(fixtureUrl(`${kind}/valid.json`)));
}

export async function loadGoldenRecordJson(kind: GoldenRecordKind): Promise<unknown> {
  return JSON.parse(await readFile(fixtureUrl(`${kind}/valid.json`), "utf8"));
}

export async function loadGoldenRecordDigest(kind: GoldenRecordKind): Promise<`sha256:${string}`> {
  return (await readFile(fixtureUrl(`${kind}/valid.sha256`), "utf8")).trim() as `sha256:${string}`;
}

/**
 * The tier-2 artifact digests of the A/B/C → A/B/C/D golden lifecycle, fixed outside the run that
 * produces them. `packages/benchmarking/evidence/src/golden-lifecycle.test.ts` asserts against
 * these, so a serialization change applied uniformly across both the A/B/C build and the D append
 * can no longer leave that test green.
 */
export interface GoldenLifecycleDigests {
  readonly benchmark: `sha256:${string}`;
  readonly manifest: `sha256:${string}`;
  readonly cohortAbc: `sha256:${string}`;
  readonly matrixAbc: `sha256:${string}`;
  readonly reportPayloadAbc: `sha256:${string}`;
  readonly reportEnvelopeAbc: `sha256:${string}`;
  readonly cohortAbcd: `sha256:${string}`;
  readonly matrixAbcd: `sha256:${string}`;
  readonly reportPayloadAbcd: `sha256:${string}`;
  readonly reportEnvelopeAbcd: `sha256:${string}`;
  readonly claimPackage: `sha256:${string}`;
  readonly bundleManifest: `sha256:${string}`;
  readonly metadataFirstBundleManifest: `sha256:${string}`;
}

export async function loadGoldenLifecycleDigests(): Promise<GoldenLifecycleDigests> {
  const { digests } = JSON.parse(
    await readFile(fixtureUrl("golden-lifecycle/digests.json"), "utf8"),
  ) as { digests: GoldenLifecycleDigests };
  return digests;
}
