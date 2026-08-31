// SPDX-License-Identifier: Apache-2.0

/**
 * `disclosure declare` and `disclosure show` (issue #2839): the window, the author binding, the
 * idempotence rule, and the producer's refusal of a declaration no closure version can express.
 *
 * Every declaration string is synthetic placeholder prose written for this file (design R7).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseDisclosureSpecification } from "@jinn-network/benchmarking-records";
import { materializePublicBundle } from "../bundle/materialize.js";
import { BUNDLE_V4_FORMAT } from "../bundle/manifest.js";
import {
  createSyntheticV4BundleFixture,
  syntheticDisclosureDeclaration,
} from "../bundle/testing/v4-synthetic-fixture.js";
import { readRunState, writeRunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { disclosureDeclare, disclosureShow } from "./disclosure-declare.js";
import type { OperationContext } from "./context.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The fixture's own sponsor principal. `disclosure.declare` is not in `GATED_OPERATIONS` — the
 * gate that matters for a declaration is `report`, which is what seals it into a claim — but every
 * operation still runs through the authority boundary, so the principal has to be a real one. */
function contextFor(workspaceDir: string): OperationContext {
  return { workspaceDir, principal: "synthetic-operator", clock: () => new Date().toISOString() };
}

/** One completed unanchored binary run. It is already REPORTED, which is what lets these tests
 * exercise the window's closing edge without paying for a second full fixture. */
async function reportedRun(label: string) {
  const workspaceDir = mkdtempSync(join(tmpdir(), `disclosure-declare-${label}-`));
  roots.push(workspaceDir);
  const built = await createSyntheticV4BundleFixture({ workspaceDir, truthAdmission: "operator-only" });
  return { workspaceDir, built, context: contextFor(workspaceDir) };
}

describe("the declaration window", () => {
  test("refuses after report — a declaration made now could never enter the sealed claim", async () => {
    const { context, built } = await reportedRun("after-report");
    const result = disclosureDeclare(context, {
      draftId: built.draftId,
      declaration: syntheticDisclosureDeclaration(built.instrumentSha256s),
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("illegal-transition");
    expect(result.ok ? "" : result.error.detail).toMatch(/declare before reporting/);
  }, 900_000);

  test("refuses before the Matrix exists — the record names a subject that is not yet sealed", async () => {
    const { context, workspaceDir, built } = await reportedRun("before-matrix");
    // Rewind exactly the two facts the window depends on, leaving the rest of the run state alone.
    const state = readRunState(workspaceDir, built.draftId)!;
    const { matrixSha256: _dropped, reportedAt: _alsoDropped, ...rewound } = state;
    writeRunState(workspaceDir, built.draftId, rewound as typeof state);

    const result = disclosureDeclare(context, {
      draftId: built.draftId,
      declaration: syntheticDisclosureDeclaration(built.instrumentSha256s),
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.detail).toMatch(/close and collect the run before declaring/);
  }, 900_000);
});

describe("what the operation seals", () => {
  test("binds the author to the run owner and the subject to the Matrix, and is re-declarable", async () => {
    const { context, workspaceDir, built } = await reportedRun("seals");
    const state = readRunState(workspaceDir, built.draftId)!;
    const { reportedAt: _reopened, ...openWindow } = state;
    writeRunState(workspaceDir, built.draftId, openWindow as typeof state);

    const first = disclosureDeclare(context, {
      draftId: built.draftId,
      declaration: syntheticDisclosureDeclaration(built.instrumentSha256s),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.result.replaced).toBe(false);
    expect(first.result.author).toBe(state.owner);
    expect(first.result.subjectSha256).toBe(state.matrixSha256);
    expect(first.result.statuses).toEqual({
      "ingestion-model": "undisclosed",
      "retrieval-config": "undisclosed",
      "answer-model": "disclosed-by-publisher",
      "answer-prompt": "disclosed-by-publisher",
      "judge-model": "measured-here",
      "judge-prompt": "measured-here",
    });

    // The sealed bytes are the record: `disclosure show` reads them back rather than restating
    // product state, and the author/subject the operation supplied are inside them.
    const shown = disclosureShow(context, { draftId: built.draftId });
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.result.recordSha256).toBe(first.result.recordSha256);
    const record = parseDisclosureSpecification(getSealedBytes(workspaceDir, first.result.recordSha256));
    expect(record.author).toBe(state.owner);
    expect(record.subject.digest.sha256).toBe(state.matrixSha256);

    // Re-declaring before report is allowed and reported as a replacement: a venue that notices its
    // own statement is wrong before reporting should be able to fix it.
    const declaration = syntheticDisclosureDeclaration(built.instrumentSha256s) as {
      variables: Record<string, { statement?: string }>;
    };
    declaration.variables["answer-prompt"] = {
      status: "undisclosed", reason: "not-stated",
    } as never;
    const second = disclosureDeclare(context, { draftId: built.draftId, declaration });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.replaced).toBe(true);
    expect(second.result.recordSha256).not.toBe(first.result.recordSha256);
    // Nothing in the content-addressed store is deleted: the superseded record is still readable.
    expect(getSealedBytes(workspaceDir, first.result.recordSha256).byteLength).toBeGreaterThan(0);

    // Idempotent: declaring the same six entries again is not a "replacement".
    const third = disclosureDeclare(context, { draftId: built.draftId, declaration });
    expect(third.ok && third.result.replaced).toBe(false);
  }, 900_000);

  test("a malformed declaration is a typed validation refusal naming the variable", async () => {
    const { context, workspaceDir, built } = await reportedRun("malformed");
    const state = readRunState(workspaceDir, built.draftId)!;
    const { reportedAt: _reopened, ...openWindow } = state;
    writeRunState(workspaceDir, built.draftId, openWindow as typeof state);

    const declaration = syntheticDisclosureDeclaration(built.instrumentSha256s) as {
      variables: Record<string, unknown>;
    };
    // R3's whole point: an assertion with nowhere to put a digest.
    declaration.variables["answer-model"] = {
      status: "disclosed-by-publisher",
      statement: "An assertion that tries to carry evidence.",
      evidence: [{ role: "pinned-configuration", digest: { sha256: "1".repeat(64) } }],
    };
    const result = disclosureDeclare(context, { draftId: built.draftId, declaration });
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("validation");
    expect(result.ok ? "" : result.error.issues?.[0]?.path).toMatch(/^disclosure\./);
  }, 900_000);
});

describe("the producer refuses a declaration no closure version expresses", () => {
  test("a declared but UNANCHORED binary run refuses at publish rather than inventing a cell", async () => {
    const { context, workspaceDir, built } = await reportedRun("no-closure");
    const state = readRunState(workspaceDir, built.draftId)!;
    const { reportedAt: _reopened, ...openWindow } = state;
    writeRunState(workspaceDir, built.draftId, openWindow as typeof state);
    const declared = disclosureDeclare(context, {
      draftId: built.draftId,
      declaration: syntheticDisclosureDeclaration(built.instrumentSha256s),
    });
    expect(declared.ok).toBe(true);
    // Restore the reported state, so the run has the sealed claim it actually published — an
    // UNDISCLOSED claim-package/2 on an unanchored binary run — while now carrying a declaration.
    writeRunState(workspaceDir, built.draftId, {
      ...readRunState(workspaceDir, built.draftId)!,
      reportedAt: state.reportedAt!,
    });

    // The v8 closure is the anchored binary-qualification cell plus a record, and there is no
    // second disclosed cell: building one would double the enumeration #2889 exists to kill.
    expect(() => materializePublicBundle({
      workspaceDir,
      draftId: built.draftId,
      benchmarkSha256: built.benchmarkSha256,
      runState: readRunState(workspaceDir, built.draftId)!,
    })).toThrow(/no other closure version expresses a disclosure declaration/);

    // And the same run with the declaration removed still publishes the v4 bundle it always did.
    const { disclosureSha256: _cleared, ...withoutDeclaration } = readRunState(workspaceDir, built.draftId)!;
    writeRunState(workspaceDir, built.draftId, withoutDeclaration as never);
    const republished = materializePublicBundle({
      workspaceDir,
      draftId: built.draftId,
      benchmarkSha256: built.benchmarkSha256,
      runState: readRunState(workspaceDir, built.draftId)!,
    });
    expect(JSON.parse(readFileSync(join(republished.bundleDir, "bundle.json"), "utf8")).format)
      .toBe(BUNDLE_V4_FORMAT);
  }, 900_000);
});
