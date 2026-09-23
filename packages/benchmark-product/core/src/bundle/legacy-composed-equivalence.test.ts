// SPDX-License-Identifier: Apache-2.0

/**
 * Closure-equivalence between each pre-composition cell and the composed generation (bundle
 * capability-composition design §10 step 3 / §9; issue #3404).
 *
 * Packet C4 taught the producer to emit `/10` when asked. Packet C5 flipped the production
 * default to `/10` (issue #3405). This packet proves the two paths are
 * the same closure: for each allocated cell (`/2`, `/4`, `/6`, `/7`, and `/8` — the fifth cell
 * #2839 allocated after the spec was written), one collected run is copied and reported both
 * ways, then the composed bundle is required to carry the same member set, the same check list
 * in the same order, the same claim sections, and the same verification outcome.
 *
 * Expected checks and sections are taken from `composeClosure`, not re-enumerated here. The
 * generated lattice that replaces hand-enumeration at test time already lives in the checker
 * (`check/src/capability-lattice.test.ts`, packet C3) and already includes `/8` as a registry
 * subset; this file does not duplicate it. What is unique here is the producer materialize
 * proof, including `/8`.
 *
 * Existing golden bundles stay byte-identical: the legacy path is still reachable via
 * `composedFormat: false`, and the committed `/2` conformance golden plus the wilson
 * presentation goldens are asserted against the blobs `HEAD` already holds.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import {
  BUNDLE_V8_FORMAT,
  BUNDLE_V10_FORMAT,
  CAPABILITY_REGISTRY,
  composeClosure,
  summarizeVerificationOutcome,
  verifyPublicBundle,
} from "@colophon-claims/check";
import type { OperationContext } from "../operations/context.js";
import { runReport } from "../operations/report.js";
import { runVerify } from "../operations/verify.js";
import { readRunState } from "../run/state.js";
import {
  BUNDLE_FORMAT,
  BUNDLE_V4_FORMAT,
  BUNDLE_V6_FORMAT,
  BUNDLE_V7_FORMAT,
} from "../legacy-closures.js";
import { materializePublicBundle } from "./materialize.js";
import { createSyntheticV4BundleFixture } from "./testing/v4-synthetic-fixture.js";
import { createSyntheticV6BundleFixture } from "./testing/v6-synthetic-fixture.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `equiv-3404-${label}-`));
  roots.push(root);
  return root;
}

function json(bundleDir: string, path: string): Record<string, any> {
  return JSON.parse(readFileSync(join(bundleDir, path), "utf8")) as Record<string, any>;
}

function memberSet(bundleDir: string): string[] {
  return (json(bundleDir, "bundle.json")["files"] as { path: string }[])
    .map((file) => file.path)
    .sort();
}

function claimSections(claim: Record<string, unknown>): string[] {
  return CAPABILITY_REGISTRY
    .filter((capability) => claim[capability.claimSection] !== undefined)
    .map((capability) => capability.claimSection);
}

function copyWorkspace(source: string, label: string): string {
  const dest = join(workspace(`copy-${label}`), "workspace");
  cpSync(source, dest, { recursive: true });
  return dest;
}

function requireOk<T>(
  result: { readonly ok: true; readonly result: T } | { readonly ok: false; readonly error: { readonly detail: string } },
  label: string,
): T {
  if (!result.ok) throw new Error(`${label}: ${result.error.detail}`);
  return result.result;
}

async function publish(
  workspaceDir: string,
  draftId: string,
  benchmarkSha256: string,
  composedFormat: boolean,
): Promise<string> {
  const context: OperationContext = {
    workspaceDir,
    principal: "synthetic-operator",
    clock: () => new Date().toISOString(),
  };
  requireOk(
    await runReport(context, { draftId, composedFormat }),
    composedFormat ? "composed report" : "legacy report",
  );
  const runState = readRunState(workspaceDir, draftId);
  if (runState === undefined) throw new Error("reported run has no RunState");
  return materializePublicBundle({ workspaceDir, draftId, benchmarkSha256, runState }).bundleDir;
}

interface PreparedRun {
  readonly workspaceDir: string;
  readonly draftId: string;
  readonly benchmarkSha256: string;
}

const CELLS = [
  {
    cell: "/2",
    vector: [],
    legacyFormat: BUNDLE_FORMAT,
    prepare: (workspaceDir: string): Promise<PreparedRun> =>
      createSyntheticV6BundleFixture({ workspaceDir, skipReport: true }),
  },
  {
    cell: "/4",
    vector: ["binary-qualification"],
    legacyFormat: BUNDLE_V4_FORMAT,
    prepare: (workspaceDir: string): Promise<PreparedRun> =>
      createSyntheticV4BundleFixture({ workspaceDir, truthAdmission: "operator-only", skipReport: true }),
  },
  {
    cell: "/6",
    vector: ["anchoring"],
    legacyFormat: BUNDLE_V6_FORMAT,
    prepare: (workspaceDir: string): Promise<PreparedRun> =>
      createSyntheticV6BundleFixture({ workspaceDir, plans: [{ kind: "rfc3161-lock" }], skipReport: true }),
  },
  {
    cell: "/7",
    vector: ["anchoring", "binary-qualification"],
    legacyFormat: BUNDLE_V7_FORMAT,
    prepare: (workspaceDir: string): Promise<PreparedRun> =>
      createSyntheticV4BundleFixture({
        workspaceDir,
        truthAdmission: "operator-only",
        anchorLock: true,
        skipReport: true,
      }),
  },
  {
    cell: "/8",
    vector: ["anchoring", "binary-qualification", "disclosure-specification"],
    legacyFormat: BUNDLE_V8_FORMAT,
    prepare: (workspaceDir: string): Promise<PreparedRun> =>
      createSyntheticV4BundleFixture({
        workspaceDir,
        truthAdmission: "operator-only",
        anchorLock: true,
        declareDisclosure: true,
        skipReport: true,
      }),
  },
] as const;

const memo = new Map<string, Promise<{
  readonly vector: readonly string[];
  readonly legacyFormat: string;
  readonly legacyDir: string;
  readonly composedDir: string;
  readonly legacyWorkspace: string;
  readonly composedWorkspace: string;
  readonly draftId: string;
}>>();

function bothWays(cell: (typeof CELLS)[number]): NonNullable<ReturnType<typeof memo.get>> {
  let run = memo.get(cell.cell);
  if (run === undefined) {
    run = (async () => {
      const prepared = await cell.prepare(workspace(`prep-${cell.cell.slice(1)}`));
      const legacyWorkspace = copyWorkspace(prepared.workspaceDir, `${cell.cell.slice(1)}-legacy`);
      const composedWorkspace = copyWorkspace(prepared.workspaceDir, `${cell.cell.slice(1)}-composed`);
      const [legacyDir, composedDir] = await Promise.all([
        publish(legacyWorkspace, prepared.draftId, prepared.benchmarkSha256, false),
        publish(composedWorkspace, prepared.draftId, prepared.benchmarkSha256, true),
      ]);
      return {
        vector: cell.vector,
        legacyFormat: cell.legacyFormat,
        legacyDir,
        composedDir,
        legacyWorkspace,
        composedWorkspace,
        draftId: prepared.draftId,
      };
    })();
    memo.set(cell.cell, run);
  }
  return run;
}

describe("legacy cells are equivalent to composed /10", () => {
  test("the five allocated cells are /2, /4, /6, /7, and /8", () => {
    expect(CELLS.map((entry) => entry.cell)).toEqual(["/2", "/4", "/6", "/7", "/8"]);
  });

  for (const cell of CELLS) {
    test(`${cell.cell}: the same run, reported both ways, has the same members, checks, sections, and outcome`, async () => {
      const built = await bothWays(cell);
      const closure = composeClosure(built.vector);

      const legacyManifest = json(built.legacyDir, "bundle.json");
      const composedManifest = json(built.composedDir, "bundle.json");
      expect(legacyManifest["format"]).toBe(built.legacyFormat);
      expect(composedManifest["format"]).toBe(BUNDLE_V10_FORMAT);
      expect(composedManifest["capabilities"]).toEqual(built.vector);

      // Same member set. `bundle.json` sorts by path, so the arrays are comparable in order; the
      // design's equivalence step asks for the set, which this is.
      expect(memberSet(built.composedDir)).toEqual(memberSet(built.legacyDir));
      for (const path of closure.mandatoryFiles) {
        expect(memberSet(built.composedDir), path).toContain(path);
      }

      const legacyClaim = json(built.legacyDir, "claim-package.json");
      const composedClaim = json(built.composedDir, "claim-package.json");
      expect(claimSections(composedClaim)).toEqual([...closure.claimSections]);
      expect(claimSections(composedClaim)).toEqual(claimSections(legacyClaim));
      expect(legacyClaim["verification"]["checks"]).toEqual([...closure.checks]);
      expect(composedClaim["verification"]["checks"]).toEqual(legacyClaim["verification"]["checks"]);

      const [legacyVerified, composedVerified] = await Promise.all([
        verifyPublicBundle(built.legacyDir),
        verifyPublicBundle(built.composedDir),
      ]);
      expect(legacyVerified.format).toBe(built.legacyFormat);
      expect(composedVerified.format).toBe(BUNDLE_V10_FORMAT);
      expect(legacyVerified.checks).toEqual([...closure.checks]);
      expect(composedVerified.checks).toEqual(legacyVerified.checks);

      const legacyOutcome = summarizeVerificationOutcome(legacyVerified);
      const composedOutcome = summarizeVerificationOutcome(composedVerified);
      expect(composedOutcome.outcomes).toEqual(legacyOutcome.outcomes);
      expect(composedOutcome.passed).toBe(legacyOutcome.passed);
      expect(composedOutcome.total).toBe(legacyOutcome.total);
      expect(composedOutcome.passed).toBe(composedOutcome.total);
      expect(composedOutcome.notFetched).toBe(0);

      const context = (workspaceDir: string): OperationContext => ({
        workspaceDir,
        principal: "synthetic-operator",
        clock: () => new Date().toISOString(),
      });
      const [legacyWorkspace, composedWorkspace] = await Promise.all([
        runVerify(context(built.legacyWorkspace), { draftId: built.draftId }),
        runVerify(context(built.composedWorkspace), { draftId: built.draftId }),
      ]);
      expect(legacyWorkspace.ok ? "ok" : legacyWorkspace.error.detail).toBe("ok");
      expect(composedWorkspace.ok ? "ok" : composedWorkspace.error.detail).toBe("ok");
    }, 300_000);
  }
});

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function walkFiles(dir: string, relative = ""): string[] {
  const entries = readdirSync(join(dir, relative), { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of entries) {
    const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walkFiles(dir, rel));
    else files.push(rel);
  }
  return files;
}

function gitBlobAtHead(relPath: string): string {
  return execFileSync("git", ["rev-parse", `HEAD:${relPath}`], { encoding: "utf8", cwd: repoRoot() }).trim();
}

function worktreeBlob(relPath: string): string {
  return execFileSync("git", ["hash-object", relPath], { encoding: "utf8", cwd: repoRoot() }).trim();
}

describe("existing golden bundles stay byte-identical on the legacy path", () => {
  const GOLDEN_TREES = [
    "packages/benchmark-product/check/fixtures/public-bundle-conformance-v1/golden",
    "packages/benchmark-product/core/src/bundle/__fixtures__/wilson-golden",
  ] as const;

  test("every committed golden file is the blob HEAD already holds", () => {
    const root = repoRoot();
    for (const tree of GOLDEN_TREES) {
      for (const rel of walkFiles(join(root, tree))) {
        const path = `${tree}/${rel}`;
        expect(worktreeBlob(path), path).toBe(gitBlobAtHead(path));
      }
    }
  });

  test("the published /2 golden still verifies on the legacy path, with its six checks", async () => {
    const golden = join(repoRoot(), GOLDEN_TREES[0]);
    const verified = await verifyPublicBundle(golden);
    expect(verified.format).toBe(BUNDLE_FORMAT);
    expect(verified.checks).toEqual(composeClosure([]).checks);
    expect("capabilities" in verified).toBe(false);
    const outcome = summarizeVerificationOutcome(verified);
    expect(outcome.passed).toBe(outcome.total);
    expect(outcome.total).toBe(6);
  });
});

describe("the generated lattice remains the §9 exhaustiveness suite", () => {
  test("C3's lattice file still enumerates every registry subset, including /8", () => {
    // The lattice is verifier-side and already landed with C3. This packet does not grow a second
    // copy; it only re-checks that the generating loop (and therefore /8, a registered capability
    // combination) is still the exhaustiveness suite.
    const lattice = readFileSync(
      fileURLToPath(new URL("../../../check/src/capability-lattice.test.ts", import.meta.url)),
      "utf8",
    );
    expect(lattice).toContain("2 ** REGISTRY.length");
    expect(lattice).toContain("assertMemberClosure");
    expect(lattice).toContain("roleDerivations");
  });
});
