// SPDX-License-Identifier: Apache-2.0

/**
 * The composed generation, emitted (bundle-capability-composition design §10 step 4, §13 packet C5;
 * issue #3405). Packet C4 taught `report` to emit `/10` when asked; C5 made that the default.
 *
 * `report` takes one explicit input, `composedFormat`. Omitted or `true`, the run publishes on
 * `benchmark-product-public-bundle/10`: the capability vector is derived from the registry's
 * activation predicates, the claim is the composed generation's `claim-package/7`, and the check
 * list and reader line are whatever that vector derives. `false` is the rollback onto the
 * enumerated `/2` `/4` `/6` `/7` `/8` cells, which `v4-`, `v6-`, `v7-`, and `v8-materialize.test.ts`
 * keep proving against the same fixtures.
 *
 * One real run per pre-composition cell, each driven through the production operations with the
 * flag set, then handed to the standalone reader as a detached copy. Five of the six vectors are the
 * five cells the closure model hand-allocated, so each of those cases also states which legacy
 * closure the composed bundle must reproduce -- the full equivalence proof is issue #3404; what is
 * asserted here is that the producer emits what the verifier accepts, cell by cell.
 * The sixth is a combination no format number was ever allocated for.
 *
 * The flag is an operation input, not a CLI switch. Rollback is flipping the default back.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { DISCLOSURE_SPECIFICATION_EXTENSION } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import {
  BUNDLE_V10_FORMAT,
  CAPABILITY_REGISTRY,
  composeClosure,
  verifyPublicBundle,
} from "@colophon-claims/check";
import type { OperationContext } from "../operations/context.js";
import { runVerify } from "../operations/verify.js";
import { COMPOSED_CLAIM_PACKAGE_SCHEMA_ID } from "../report/claim.js";
import {
  PUBLIC_BUNDLE_V6_CHECKS,
  PUBLIC_BUNDLE_V7_CHECKS,
  PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_VERIFICATION_CHECKS,
} from "../legacy-closures.js";
import { buildBundleManifest } from "./manifest.js";
import { createSyntheticV4BundleFixture } from "./testing/v4-synthetic-fixture.js";
import { createSyntheticV6BundleFixture } from "./testing/v6-synthetic-fixture.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `composed-v10-${label}-`));
  roots.push(root);
  return root;
}

interface ComposedRun {
  readonly workspaceDir: string;
  readonly draftId: string;
  readonly bundleDir: string;
}

/** One real run per cell, built once and shared: each drives lock, launch, collect, report, and
 * materialize through the production operations. Tamper tests copy the directory. */
const memo = new Map<string, Promise<ComposedRun>>();
function once(label: string, build: (workspaceDir: string) => Promise<{ workspaceDir: string; draftId: string; bundle: { bundleDir: string } }>): Promise<ComposedRun> {
  let run = memo.get(label);
  if (run === undefined) {
    run = build(workspace(label)).then((built) => ({
      workspaceDir: built.workspaceDir,
      draftId: built.draftId,
      bundleDir: built.bundle.bundleDir,
    }));
    memo.set(label, run);
  }
  return run;
}

const CELLS = [
  {
    // The two wilson cells also declare `slot-denominators` (issue #3698): no member, no check,
    // and no claim section, so each still reproduces its legacy cell's closure.
    cell: "/2",
    vector: ["slot-denominators"],
    checks: PUBLIC_BUNDLE_VERIFICATION_CHECKS,
    run: () => once("base", (workspaceDir) => createSyntheticV6BundleFixture({ workspaceDir, composedFormat: true })),
  },
  {
    cell: "/4",
    vector: ["binary-qualification"],
    checks: PUBLIC_BUNDLE_VERIFICATION_CHECKS,
    run: () => once("qualified", (workspaceDir) =>
      createSyntheticV4BundleFixture({ workspaceDir, truthAdmission: "operator-only", composedFormat: true })),
  },
  {
    cell: "/6",
    vector: ["anchoring", "slot-denominators"],
    checks: PUBLIC_BUNDLE_V6_CHECKS,
    run: () => once("anchored", (workspaceDir) =>
      createSyntheticV6BundleFixture({ workspaceDir, plans: [{ kind: "rfc3161-lock" }], composedFormat: true })),
  },
  {
    cell: "/7",
    vector: ["anchoring", "binary-qualification"],
    checks: PUBLIC_BUNDLE_V7_CHECKS,
    run: () => once("anchored-qualified", (workspaceDir) =>
      createSyntheticV4BundleFixture({ workspaceDir, truthAdmission: "operator-only", anchorLock: true, composedFormat: true })),
  },
  {
    cell: "/8",
    vector: ["anchoring", "binary-qualification", "disclosure-specification"],
    checks: [...PUBLIC_BUNDLE_V7_CHECKS, "disclosure-specification"],
    run: () => once("disclosed", (workspaceDir) =>
      createSyntheticV4BundleFixture({
        workspaceDir,
        truthAdmission: "operator-only",
        anchorLock: true,
        declareDisclosure: true,
        composedFormat: true,
      })),
  },
  {
    // The cell the closure model never allocated: disclosed and qualified, UNANCHORED. On the
    // legacy path this run is refused at `report`, because `/8` is the one disclosed cell and it is
    // anchored. Composed, the registry lets the record ride any qualification bundle, so the
    // combination costs nothing: no format number, no claim-package id, no check array.
    cell: "no legacy cell",
    vector: ["binary-qualification", "disclosure-specification"],
    checks: [...PUBLIC_BUNDLE_VERIFICATION_CHECKS, "disclosure-specification"],
    run: () => once("disclosed-unanchored", (workspaceDir) =>
      createSyntheticV4BundleFixture({
        workspaceDir,
        truthAdmission: "operator-only",
        declareDisclosure: true,
        composedFormat: true,
      })),
  },
] as const;

/** By name, never by position: a cell inserted above would silently repoint an index. */
function cell(name: (typeof CELLS)[number]["cell"]): (typeof CELLS)[number] {
  return CELLS.find((entry) => entry.cell === name)!;
}

function json(bundleDir: string, path: string): Record<string, any> {
  return JSON.parse(readFileSync(join(bundleDir, path), "utf8")) as Record<string, any>;
}

function detach(bundleDir: string, label: string): string {
  const copy = join(workspace(`copy-${label}`), "bundle");
  cpSync(bundleDir, copy, { recursive: true });
  return copy;
}

/** Re-seals the manifest with another vector over the tree as it stands, so what the reader
 * refuses is the declaration and not a stale digest it would have caught anyway. */
function redeclare(bundleDir: string, capabilities: readonly string[]): void {
  const paths = (json(bundleDir, "bundle.json")["files"] as { path: string }[]).map((file) => file.path);
  writeFileSync(
    join(bundleDir, "bundle.json"),
    buildBundleManifest(bundleDir, paths, { format: BUNDLE_V10_FORMAT, capabilities }).bytes,
  );
}

async function refusal(bundleDir: string): Promise<{ path: string; message: string }> {
  try {
    await verifyPublicBundle(bundleDir);
  } catch (cause) {
    const issue = (cause as { readonly issues?: readonly { path?: string; message?: string }[] }).issues?.[0];
    return { path: issue?.path ?? "", message: issue?.message ?? String(cause) };
  }
  return { path: "NOT REFUSED", message: "NOT REFUSED" };
}

describe("composed bundle v10 — producer, one run per pre-composition cell", () => {
  for (const expected of CELLS) {
    test(`${expected.cell}: the run, asked for the composed format, declares ${JSON.stringify(expected.vector)}`, async () => {
      const built = await expected.run();
      const closure = composeClosure(expected.vector);

      // The manifest states the vector the activation predicates derive, in canonical wire order.
      const manifest = json(built.bundleDir, "bundle.json");
      expect(manifest["format"]).toBe(BUNDLE_V10_FORMAT);
      expect(manifest["capabilities"]).toEqual(expected.vector);
      const members = new Set((manifest["files"] as { path: string }[]).map((file) => file.path));
      for (const path of closure.mandatoryFiles) expect(members.has(path), path).toBe(true);
      // One direction only. `anchoring` may carry no member -- a Run that declared intent no
      // carried anchor satisfies still declares it -- so what is invariant is that an undeclared
      // capability contributes none. The reader's own two-way closure below covers the rest.
      if (!(expected.vector as readonly string[]).includes("anchoring")) {
        expect([...members].filter((path) => path.startsWith("anchors/"))).toEqual([]);
      }

      // One claim id for every vector; sections present exactly when declared; derived pins.
      const claim = json(built.bundleDir, "claim-package.json");
      expect(claim["claimSchema"]).toBe(COMPOSED_CLAIM_PACKAGE_SCHEMA_ID);
      for (const capability of CAPABILITY_REGISTRY) {
        if (!("claimSection" in capability)) continue;
        expect(claim[capability.claimSection] !== undefined, capability.claimSection)
          .toBe((expected.vector as readonly string[]).includes(capability.token));
      }
      expect(claim["verification"]["checks"]).toEqual(expected.checks);
      // Against the literal lines, not against the derivation that produced them: every vector
      // registered today pins the first checker release, which reads `/10`, and never the verify
      // 0.2.1 line `/7` and `/8` pin or `/6`'s first-public 0.1, which refuse it (issue #4746).
      expect(claim["verification"]["command"]).toBe("npx @colophon-claims/check@0.2.1 <bundle-dir>");
      expect(claim["verification"]["compatibleCommand"]).toBe("npx @colophon-claims/check@0.2 <bundle-dir>");
      expect(claim["verification"]["command"]).not.toBe(PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND);
      expect(claim["verification"]["compatibleCommand"]).not.toBe(PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND);
      // The Report extension is the disclosure capability's one edge, present exactly when declared.
      expect(json(built.bundleDir, "report.json")[DISCLOSURE_SPECIFICATION_EXTENSION] !== undefined)
        .toBe((expected.vector as readonly string[]).includes("disclosure-specification"));

      // The standalone reader, handed a detached copy, runs the legacy cell's checks in its order.
      const verified = await verifyPublicBundle(detach(built.bundleDir, "verified"));
      expect(verified.format).toBe(BUNDLE_V10_FORMAT);
      if (verified.format !== BUNDLE_V10_FORMAT) throw new Error("unreachable");
      expect(verified.capabilities).toEqual(expected.vector);
      expect(verified.checks).toEqual(expected.checks);

      // The workspace's own verification rebuilds the same composed claim from durable state.
      const context: OperationContext = {
        workspaceDir: built.workspaceDir,
        principal: "synthetic-operator",
        clock: () => new Date().toISOString(),
      };
      const workspaceVerified = await runVerify(context, { draftId: built.draftId });
      expect(workspaceVerified.ok ? "ok" : workspaceVerified.error.detail).toBe("ok");
    }, 300_000);
  }
});

describe("composed bundle v10 — a real bundle under another declaration", () => {
  test("dropping a declared capability never yields a quieter bundle", async () => {
    const disclosed = await cell("/8").run();

    // `disclosure-specification` has no member of its own, so the member closure has nothing to
    // object to. The Report still names the record, and the closure-independent guard refuses it.
    const undisclosed = detach(disclosed.bundleDir, "undisclosed");
    redeclare(undisclosed, ["anchoring", "binary-qualification"]);
    expect(await refusal(undisclosed)).toEqual({
      path: "report.json",
      message: expect.stringContaining("publishable only on"),
    });

    const unanchored = detach(disclosed.bundleDir, "unanchored");
    redeclare(unanchored, ["binary-qualification", "disclosure-specification"]);
    expect(await refusal(unanchored)).toEqual({
      path: expect.stringMatching(/^anchors\/[a-f0-9]{64}\.bin$/u),
      message: expect.stringContaining("non-allowlisted"),
    });

    // A REFINING capability dropped: the members it refined are still in the qualification grammar,
    // and with the declaration gone the reader parses them under the base grammar, so the refusal
    // is the refined grammar's own and arrives before the member closure is ever reached. Taken
    // from the undisclosed cell, so the closure-independent guard above is not what fires.
    const qualified = await cell("/7").run();
    const unqualified = detach(qualified.bundleDir, "unqualified");
    redeclare(unqualified, ["anchoring"]);
    expect(await refusal(unqualified)).toEqual({
      path: "evidence.json",
      message: "evidence.json does not satisfy its public bundle schema",
    });
  }, 300_000);

  test("a role only an undeclared capability can derive leaves its record unreachable", async () => {
    // Design §6 step 2 and §9: evidence-catalog role derivations are the base graph's plus each
    // DECLARED capability's. The declared half is the `/8` cell above, whose record verifies
    // because the declared `disclosure-specification` contributes the derivation. This is the
    // undeclared half: the same record and its catalog entry carried into a bundle whose vector
    // does not declare the capability, and whose Report names no record. Nothing derives the role
    // there, so the closed-world evidence-closure compare refuses it — no bespoke guard involved.
    const disclosed = await cell("/8").run();
    const qualified = await cell("/7").run();
    const extension = json(disclosed.bundleDir, "report.json")[DISCLOSURE_SPECIFICATION_EXTENSION];
    const recordPath = `records/${extension.digest.sha256 as string}.bin`;

    const smuggled = detach(qualified.bundleDir, "smuggled");
    cpSync(join(disclosed.bundleDir, recordPath), join(smuggled, recordPath));
    const catalog = json(smuggled, "evidence.json");
    (catalog["records"] as { sha256: string; roles: string[] }[]).push({
      sha256: extension.digest.sha256 as string,
      roles: ["disclosure-specification"],
    });
    (catalog["records"] as { sha256: string }[]).sort((left, right) => (left.sha256 < right.sha256 ? -1 : 1));
    writeFileSync(join(smuggled, "evidence.json"), canonicalJsonBytes(catalog as never));
    const paths = [...(json(smuggled, "bundle.json")["files"] as { path: string }[]).map((file) => file.path), recordPath];
    writeFileSync(
      join(smuggled, "bundle.json"),
      buildBundleManifest(smuggled, paths, { format: BUNDLE_V10_FORMAT, capabilities: ["anchoring", "binary-qualification"] }).bytes,
    );
    expect((await refusal(smuggled)).path).toBe("evidence-closure");
  }, 300_000);

  test("declaring a capability the bundle does not carry is refused", async () => {
    const qualified = await cell("/7").run();

    // Declared without its record: nothing on this Report names a disclosure-specification record.
    const overdeclared = detach(qualified.bundleDir, "overdeclared");
    redeclare(overdeclared, ["anchoring", "binary-qualification", "disclosure-specification"]);
    expect(await refusal(overdeclared)).toEqual({
      path: "disclosure-specification",
      message: expect.stringContaining(`must carry ${DISCLOSURE_SPECIFICATION_EXTENSION}`),
    });

    // Declared without its members, on the base cell: there is no qualification document.
    const base = await cell("/2").run();
    const unbacked = detach(base.bundleDir, "unbacked");
    redeclare(unbacked, ["binary-qualification"]);
    expect(await refusal(unbacked)).toEqual({
      path: "qualification.json",
      message: expect.stringContaining("is missing"),
    });
  }, 300_000);
});
