// SPDX-License-Identifier: Apache-2.0

/**
 * Packet C5 / issue #3405: clean cutover of the producer default to composed `/10`.
 *
 * Packet C4 taught `report` to emit `/10` when asked. Packet C3 taught the in-tree checker to
 * read it. This packet flips the default: omitting `composedFormat` is the composed generation,
 * `composedFormat: false` is the rollback onto the enumerated cells, and the verifier's legacy
 * path for `/2`, `/4`, `/6`, `/7`, and `/8` is untouched.
 *
 * No new format number. `/9` stays a hole. Dual-emit is refused: one default, not two.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  BUNDLE_V10_FORMAT,
  COMPOSED_CLAIM_PACKAGE_SCHEMA_ID,
  summarizeVerificationOutcome,
  verifyPublicBundle,
} from "@colophon-claims/check";
import type { OperationContext } from "../operations/context.js";
import { runReport } from "../operations/report.js";
import { readRunState } from "../run/state.js";
import { BUNDLE_FORMAT, CLAIM_PACKAGE_SCHEMA_ID } from "../legacy-closures.js";
import { materializePublicBundle } from "./materialize.js";
import { createSyntheticV6BundleFixture } from "./testing/v6-synthetic-fixture.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `cutover-3405-${label}-`));
  roots.push(root);
  return root;
}

function json(bundleDir: string, path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(bundleDir, path), "utf8")) as Record<string, unknown>;
}

function contextFor(workspaceDir: string): OperationContext {
  return {
    workspaceDir,
    principal: "synthetic-operator",
    clock: () => new Date().toISOString(),
  };
}

async function reportAndPublish(
  workspaceDir: string,
  draftId: string,
  benchmarkSha256: string,
  input: { readonly composedFormat?: boolean } = {},
): Promise<string> {
  const reported = await runReport(contextFor(workspaceDir), { draftId, ...input });
  if (!reported.ok) throw new Error(`report: ${reported.error.detail}`);
  const runState = readRunState(workspaceDir, draftId);
  if (runState === undefined) throw new Error("reported run has no RunState");
  return materializePublicBundle({ workspaceDir, draftId, benchmarkSha256, runState }).bundleDir;
}

describe("D1 clean cutover: new bundles emit composed /10", () => {
  test("omitting composedFormat publishes /10, and the in-tree checker reads it end to end", async () => {
    const prepared = await createSyntheticV6BundleFixture({
      workspaceDir: workspace("default"),
      skipReport: true,
    });
    const bundleDir = await reportAndPublish(prepared.workspaceDir, prepared.draftId, prepared.benchmarkSha256);

    const manifest = json(bundleDir, "bundle.json");
    expect(manifest["format"]).toBe(BUNDLE_V10_FORMAT);
    expect(manifest["capabilities"]).toEqual([]);
    expect(json(bundleDir, "claim-package.json")["claimSchema"]).toBe(COMPOSED_CLAIM_PACKAGE_SCHEMA_ID);

    const verified = await verifyPublicBundle(bundleDir);
    expect(verified.format).toBe(BUNDLE_V10_FORMAT);
    if (verified.format !== BUNDLE_V10_FORMAT) throw new Error("unreachable");
    expect(verified.capabilities).toEqual([]);
    const outcome = summarizeVerificationOutcome(verified);
    expect(outcome.passed).toBe(outcome.total);
    expect(outcome.total).toBe(6);
  }, 300_000);

  test("composedFormat: false is the rollback and still emits the enumerated /2 cell", async () => {
    const prepared = await createSyntheticV6BundleFixture({
      workspaceDir: workspace("rollback"),
      skipReport: true,
    });
    const bundleDir = await reportAndPublish(
      prepared.workspaceDir,
      prepared.draftId,
      prepared.benchmarkSha256,
      { composedFormat: false },
    );

    const manifest = json(bundleDir, "bundle.json");
    expect(manifest["format"]).toBe(BUNDLE_FORMAT);
    expect(manifest).not.toHaveProperty("capabilities");
    expect(json(bundleDir, "claim-package.json")["claimSchema"]).toBe(CLAIM_PACKAGE_SCHEMA_ID);

    const verified = await verifyPublicBundle(bundleDir);
    expect(verified.format).toBe(BUNDLE_FORMAT);
    expect("capabilities" in verified).toBe(false);
  }, 300_000);
});
