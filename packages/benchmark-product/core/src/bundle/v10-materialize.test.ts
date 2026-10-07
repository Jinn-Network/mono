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
 * flag set, then handed to the standalone reader as a detached copy. Five of the eight vectors are
 * the five cells the closure model hand-allocated, so each of those cases also states which legacy
 * closure the composed bundle must reproduce -- the full equivalence proof is issue #3404; what is
 * asserted here is that the producer emits what the verifier accepts, cell by cell.
 * The sixth is a combination no format number was ever allocated for, and the last two declare a
 * capability that exists only in the composed generation (issue #3416).
 *
 * Every vector also declares `owner-controlled-publication` (issue #3401): this product publishes
 * only from its self-run venue, whose publication source is owner-controlled, so every composed
 * bundle seals the sixth venue sentence. It adds no member and no check, so each cell's check list
 * is still its legacy closure's.
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
  OWNER_CONTROLLED_PUBLICATION_LIMIT,
  TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
  TERMINAL_BENCH_21_PINS,
  composeClosure,
  verifyPublicBundle,
} from "@colophon-claims/check";
import { parseEvaluationSpec } from "@jinn-network/task-execution-profiles";
import type { OperationContext } from "../operations/context.js";
import { runVerify } from "../operations/verify.js";
import { COMPOSED_CLAIM_PACKAGE_SCHEMA_ID } from "../report/claim.js";
import { LOCAL_VENUE_LIMITS } from "../operations/run-results.js";
import {
  PUBLIC_BUNDLE_V6_CHECKS,
  PUBLIC_BUNDLE_V7_CHECKS,
  PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_VERIFICATION_CHECKS,
} from "../legacy-closures.js";
import { buildBundleManifest } from "./manifest.js";
import { createTerminalBench21SlateBundleFixture } from "./testing/terminal-bench-2-1-slate-fixture.js";
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
    cell: "/2",
    vector: ["owner-controlled-publication"],
    checks: PUBLIC_BUNDLE_VERIFICATION_CHECKS,
    run: () => once("base", (workspaceDir) => createSyntheticV6BundleFixture({ workspaceDir, composedFormat: true })),
  },
  {
    cell: "/4",
    vector: ["binary-qualification", "owner-controlled-publication"],
    checks: PUBLIC_BUNDLE_VERIFICATION_CHECKS,
    run: () => once("qualified", (workspaceDir) =>
      createSyntheticV4BundleFixture({ workspaceDir, truthAdmission: "operator-only", composedFormat: true })),
  },
  {
    cell: "/6",
    vector: ["anchoring", "owner-controlled-publication"],
    checks: PUBLIC_BUNDLE_V6_CHECKS,
    run: () => once("anchored", (workspaceDir) =>
      createSyntheticV6BundleFixture({ workspaceDir, plans: [{ kind: "rfc3161-lock" }], composedFormat: true })),
  },
  {
    cell: "/7",
    vector: ["anchoring", "binary-qualification", "owner-controlled-publication"],
    checks: PUBLIC_BUNDLE_V7_CHECKS,
    run: () => once("anchored-qualified", (workspaceDir) =>
      createSyntheticV4BundleFixture({ workspaceDir, truthAdmission: "operator-only", anchorLock: true, composedFormat: true })),
  },
  {
    cell: "/8",
    vector: ["anchoring", "binary-qualification", "disclosure-specification", "owner-controlled-publication"],
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
    vector: ["binary-qualification", "disclosure-specification", "owner-controlled-publication"],
    checks: [...PUBLIC_BUNDLE_VERIFICATION_CHECKS, "disclosure-specification"],
    run: () => once("disclosed-unanchored", (workspaceDir) =>
      createSyntheticV4BundleFixture({
        workspaceDir,
        truthAdmission: "operator-only",
        declareDisclosure: true,
        composedFormat: true,
      })),
  },
  {
    // Issue #3416: a Run that declares who chose its tasks. The capability has no member and no
    // check of its own; what it adds is the claim section and the report face's header fact row.
    // On the rollback path the same run publishes `/2` with neither (`v6-verify.test.ts`).
    cell: "task selection",
    vector: ["owner-controlled-publication", "task-selection"],
    checks: PUBLIC_BUNDLE_VERIFICATION_CHECKS,
    run: () => once("task-selection", (workspaceDir) =>
      createSyntheticV6BundleFixture({ workspaceDir, taskSelection: "claimant-chosen", composedFormat: true })),
  },
  {
    // The same declaration on a qualification run: the capability composes with a refining one,
    // and the binary claim's control-shape gate admits the section.
    cell: "task selection, qualified",
    vector: ["binary-qualification", "owner-controlled-publication", "task-selection"],
    checks: PUBLIC_BUNDLE_VERIFICATION_CHECKS,
    run: () => once("task-selection-qualified", (workspaceDir) =>
      createSyntheticV4BundleFixture({
        workspaceDir,
        truthAdmission: "operator-only",
        taskSelection: "claimant-chosen",
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
      // The sixth venue sentence (issue #3401), right after the five, once, in each sealed copy.
      const reportLimitations = json(built.bundleDir, "report.json")["limitations"] as string[];
      // The five are the run's own (the qualification cells' venue is multi-policy), then the sixth.
      expect(reportLimitations.slice(0, 2)).toEqual(LOCAL_VENUE_LIMITS.slice(0, 2));
      expect(reportLimitations.slice(3, 5)).toEqual(LOCAL_VENUE_LIMITS.slice(3, 5));
      expect(reportLimitations[5]).toBe(OWNER_CONTROLLED_PUBLICATION_LIMIT);
      expect(reportLimitations.filter((line) => line === OWNER_CONTROLLED_PUBLICATION_LIMIT)).toHaveLength(1);
      expect(claim["limitations"]).toEqual(reportLimitations);
      // Anchoring rewrites the second sentence and appends its own lines after the sixth.
      expect(claim["venueHonesty"]["limits"][5]).toBe(OWNER_CONTROLLED_PUBLICATION_LIMIT);
      expect(claim["ownerControlledPublication"]).toBe(OWNER_CONTROLLED_PUBLICATION_LIMIT);
      // The page renders the sealed copies; the report page escapes the apostrophe.
      const page = readFileSync(join(built.bundleDir, "index.html"), "utf8");
      expect(page).toContain(OWNER_CONTROLLED_PUBLICATION_LIMIT.replace("'", "&#39;"));

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
    redeclare(undisclosed, ["anchoring", "binary-qualification", "owner-controlled-publication"]);
    expect(await refusal(undisclosed)).toEqual({
      path: "report.json",
      message: expect.stringContaining("publishable only on"),
    });

    const unanchored = detach(disclosed.bundleDir, "unanchored");
    redeclare(unanchored, ["binary-qualification", "disclosure-specification", "owner-controlled-publication"]);
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
    redeclare(unqualified, ["anchoring", "owner-controlled-publication"]);
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
      buildBundleManifest(smuggled, paths, {
        format: BUNDLE_V10_FORMAT,
        capabilities: ["anchoring", "binary-qualification", "owner-controlled-publication"],
      }).bytes,
    );
    expect((await refusal(smuggled)).path).toBe("evidence-closure");
  }, 300_000);

  test("the sixth sentence without its declaration is refused (issue #3401)", async () => {
    const base = await cell("/2").run();

    // The whole bundle as sealed, redeclared without the capability: the claim's section is the
    // first thing the rebuild no longer derives.
    const redeclared = detach(base.bundleDir, "undeclared-publication");
    redeclare(redeclared, []);
    expect(await refusal(redeclared)).toEqual({
      path: "claim-consistency",
      message: "claim package ownerControlledPublication is not the exact projection of verified facts",
    });

    // The claim rewritten to the five as well, so it matches the undeclared rebuild exactly. The
    // signed Report still seals the sentence, and that alone is refused.
    const rewritten = detach(base.bundleDir, "undeclared-publication-claim");
    const claim = json(rewritten, "claim-package.json");
    delete claim["ownerControlledPublication"];
    claim["venueHonesty"]["limits"] = [...LOCAL_VENUE_LIMITS];
    writeFileSync(join(rewritten, "claim-package.json"), canonicalJsonBytes(claim as never));
    redeclare(rewritten, []);
    expect(await refusal(rewritten)).toEqual({
      path: "claim-consistency",
      message: "Report limitations carry the publication-source sentence, but the bundle does not declare owner-controlled-publication",
    });
  }, 300_000);

  test("the declaration without the sixth sentence in the claim is refused (issue #3401)", async () => {
    const base = await cell("/2").run();
    for (const [label, strip] of [
      ["section", (claim: Record<string, any>) => { delete claim["ownerControlledPublication"]; }],
      ["venue sentences", (claim: Record<string, any>) => { claim["venueHonesty"]["limits"] = [...LOCAL_VENUE_LIMITS]; }],
    ] as const) {
      const stripped = detach(base.bundleDir, `stripped-${label.replace(" ", "-")}`);
      const claim = json(stripped, "claim-package.json");
      strip(claim);
      writeFileSync(join(stripped, "claim-package.json"), canonicalJsonBytes(claim as never));
      redeclare(stripped, ["owner-controlled-publication"]);
      expect(await refusal(stripped), label).toEqual({
        path: "claim-consistency",
        message: expect.stringMatching(/^claim package (ownerControlledPublication|venueHonesty\.limits) is not the exact projection/u),
      });
    }
  }, 300_000);

  test("declaring a capability the bundle does not carry is refused", async () => {
    const qualified = await cell("/7").run();

    // Declared without its record: nothing on this Report names a disclosure-specification record.
    const overdeclared = detach(qualified.bundleDir, "overdeclared");
    redeclare(overdeclared, ["anchoring", "binary-qualification", "disclosure-specification", "owner-controlled-publication"]);
    expect(await refusal(overdeclared)).toEqual({
      path: "disclosure-specification",
      message: expect.stringContaining(`must carry ${DISCLOSURE_SPECIFICATION_EXTENSION}`),
    });

    // Declared without its members, on the base cell: there is no qualification document.
    const base = await cell("/2").run();
    const unbacked = detach(base.bundleDir, "unbacked");
    redeclare(unbacked, ["binary-qualification", "owner-controlled-publication"]);
    expect(await refusal(unbacked)).toEqual({
      path: "qualification.json",
      message: expect.stringContaining("is missing"),
    });
  }, 300_000);
});

/**
 * Issue #3416 (operator ruling 2026-09-24): task selection renders as the declared `/10`
 * capability `task-selection`, and a bundle cannot pass while hiding who chose its tasks.
 */
describe("composed bundle v10: task selection at headline weight", () => {
  const ROW = '<dl class="facts"><div><dt>Task selection</dt><dd>claimant-chosen</dd></div></dl>';
  const LINE = "Task selection: claimant-chosen.";
  const read = (bundleDir: string, path: string): string => readFileSync(join(bundleDir, path), "utf8");

  test("the report face states the declared mode as a header fact row", async () => {
    const declared = await cell("task selection").run();
    const html = read(declared.bundleDir, "index.html");
    expect(html.slice(html.indexOf("<header>"), html.indexOf("</header>"))).toContain(ROW);
    expect(read(declared.bundleDir, "README.md")).toContain(`\n\n${LINE}\n\n`);
    expect(read(declared.bundleDir, "share.txt")).toContain(` self-run. ${LINE} `);
    expect(json(declared.bundleDir, "claim-package.json")["taskSelection"]).toEqual({ mode: "claimant-chosen" });

    // The qualification page carries the same row, and its share sentence the same clause.
    const qualified = await cell("task selection, qualified").run();
    const qualifiedHtml = read(qualified.bundleDir, "index.html");
    expect(qualifiedHtml.slice(qualifiedHtml.indexOf("<header>"), qualifiedHtml.indexOf("</header>"))).toContain(ROW);
    expect(read(qualified.bundleDir, "README.md")).toContain(`\n\n${LINE}\n\n`);
    expect(read(qualified.bundleDir, "share.txt")).toMatch(/^Colophon · verified qualification\. [^\n]+ self-run\. Task selection: claimant-chosen\. Report [a-f0-9]{64}\. /u);

    // A run that declares nothing states nothing, on any asset.
    const base = await cell("/2").run();
    for (const asset of ["index.html", "README.md", "share.txt", "badge.svg", "social-card.svg"]) {
      expect(read(base.bundleDir, asset), asset).not.toContain("Task selection");
    }
  }, 300_000);

  test("hiding the declaration is refused, even with the section and the row stripped to match", async () => {
    // The whole hiding edit: the token, the claim section, and the row, each removed as a producer
    // that wanted a quieter page would remove them. The Run still says who chose its tasks, and it
    // is under the report author's signature, so the vector is refused against it.
    const declared = await cell("task selection").run();
    const hidden = detach(declared.bundleDir, "hidden");
    const claim = json(hidden, "claim-package.json");
    delete claim["taskSelection"];
    writeFileSync(join(hidden, "claim-package.json"), canonicalJsonBytes(claim as never));
    writeFileSync(join(hidden, "index.html"), read(hidden, "index.html").replace(`\n${ROW}`, ""));
    writeFileSync(join(hidden, "README.md"), read(hidden, "README.md").replace(`\n\n${LINE}`, ""));
    writeFileSync(join(hidden, "share.txt"), read(hidden, "share.txt").replace(` ${LINE}`, ""));
    redeclare(hidden, ["owner-controlled-publication"]);
    expect(await refusal(hidden)).toEqual({
      path: "bundle.manifest.capabilities",
      message: expect.stringContaining("cannot pass while hiding who chose its tasks"),
    });
  }, 300_000);

  test("declaring task-selection over a Run that declares nothing is refused", async () => {
    const base = await cell("/2").run();
    const overclaimed = detach(base.bundleDir, "overclaimed");
    redeclare(overclaimed, ["owner-controlled-publication", "task-selection"]);
    expect(await refusal(overclaimed)).toEqual({
      path: "bundle.manifest.capabilities",
      message: expect.stringContaining("carries no task-selection/v1 declaration"),
    });
  }, 300_000);

  test("a softened section is refused at the claim, though the schema admits it", async () => {
    const declared = await cell("task selection").run();
    const softened = detach(declared.bundleDir, "softened");
    const claim = json(softened, "claim-package.json");
    claim["taskSelection"] = { mode: "fixed-public-set" };
    writeFileSync(join(softened, "claim-package.json"), canonicalJsonBytes(claim as never));
    redeclare(softened, ["owner-controlled-publication", "task-selection"]);
    expect(await refusal(softened)).toEqual({
      path: "claim-consistency",
      message: expect.stringContaining("taskSelection.mode"),
    });
  }, 300_000);

  test("a page that drops the row is refused on the page", async () => {
    const declared = await cell("task selection").run();
    const rowless = detach(declared.bundleDir, "rowless");
    writeFileSync(join(rowless, "index.html"), read(rowless, "index.html").replace(`\n${ROW}`, ""));
    redeclare(rowless, ["owner-controlled-publication", "task-selection"]);
    expect(await refusal(rowless)).toEqual({
      path: "index.html",
      message: expect.stringContaining("not the exact projection"),
    });
  }, 300_000);
});

/**
 * Operator rulings of 2026-10-06, decisions 1, 2 and 7: a run brought onto the official
 * Terminal-Bench 2.1 slate publishes a bundle the checker accepts, with
 * `terminal-bench-2-1-comparability` declared.
 *
 * This is the bundle-level positive case the capability could not have before each official Task
 * bound an EvaluationSpec: a Task with no spec fails the evidence closure. Every cell here is
 * graded by the sealed `external-verifier` rule over Harbor's `reward`, and the reader recomputes
 * each verdict from the bundle.
 */
describe("composed bundle v10: a run brought onto the official Terminal-Bench 2.1 slate", () => {
  const SLATE_VECTOR = ["external-import", "owner-controlled-publication", "terminal-bench-2-1-comparability"] as const;
  const SLATE_CHECKS = [...PUBLIC_BUNDLE_VERIFICATION_CHECKS, "external-import"];
  const slate = () => once("official-slate", (workspaceDir) => createTerminalBench21SlateBundleFixture({ workspaceDir }));

  test("the checker accepts the published bundle, with the capability declared", async () => {
    const built = await slate();

    const manifest = json(built.bundleDir, "bundle.json");
    expect(manifest["format"]).toBe(BUNDLE_V10_FORMAT);
    expect(manifest["capabilities"]).toEqual(SLATE_VECTOR);

    // The claim section is the projection of the Benchmark's own extension, and the sentence is
    // sealed once in the signed Report, after the venue sentences of an imported run.
    const claim = json(built.bundleDir, "claim-package.json");
    expect(claim["claimSchema"]).toBe(COMPOSED_CLAIM_PACKAGE_SCHEMA_ID);
    expect(claim["terminalBench21Comparability"]).toEqual({
      datasetId: TERMINAL_BENCH_21_PINS.datasetId,
      datasetRevision: TERMINAL_BENCH_21_PINS.datasetRevision,
      upstreamCommit: TERMINAL_BENCH_21_PINS.upstreamCommit,
      slateDigest: TERMINAL_BENCH_21_PINS.slateDigest,
      coverage: "custom",
      selectedTaskCount: 3,
      datasetTaskCount: 89,
      limit: TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
    });
    const limitations = json(built.bundleDir, "report.json")["limitations"] as string[];
    expect(limitations.filter((line) => line === TERMINAL_BENCH_21_COMPARABILITY_LIMIT)).toHaveLength(1);
    expect(limitations[5]).toBe(OWNER_CONTROLLED_PUBLICATION_LIMIT);
    expect(limitations[6]).toBe(TERMINAL_BENCH_21_COMPARABILITY_LIMIT);
    expect(claim["limitations"]).toEqual(limitations);
    expect(claim["verification"]["checks"]).toEqual(SLATE_CHECKS);
    expect(claim["verification"]["command"]).toBe("npx @colophon-claims/check@0.2.1 <bundle-dir>");

    // The standalone reader, handed a detached copy with no workspace behind it.
    const verified = await verifyPublicBundle(detach(built.bundleDir, "slate-verified"));
    expect(verified.format).toBe(BUNDLE_V10_FORMAT);
    if (verified.format !== BUNDLE_V10_FORMAT) throw new Error("unreachable");
    expect(verified.capabilities).toEqual(SLATE_VECTOR);
    expect(verified.checks).toEqual(SLATE_CHECKS);

    // The workspace's own verification rebuilds the same claim from durable state.
    const context: OperationContext = {
      workspaceDir: built.workspaceDir,
      principal: "sponsor-1",
      clock: () => new Date().toISOString(),
    };
    const workspaceVerified = await runVerify(context, { draftId: built.draftId });
    expect(workspaceVerified.ok ? "ok" : workspaceVerified.error.detail).toBe("ok");
  }, 300_000);

  test("carries each official Task at its pinned digest, and the external-verifier spec it binds", async () => {
    const built = await slate();
    const benchmark = json(built.bundleDir, "benchmark.json") as { items: { task: { digest: { sha256: string } } }[] };
    const catalog = json(built.bundleDir, "evidence.json") as { records: { sha256: string; roles: string[] }[] };
    const rolesOf = (sha256: string) => catalog.records.find((record) => record.sha256 === sha256)?.roles;
    expect(benchmark.items).toHaveLength(3);
    for (const [index, item] of benchmark.items.entries()) {
      const pinned = TERMINAL_BENCH_21_PINS.tasks[index]!;
      expect(item.task.digest.sha256, pinned.name).toBe(pinned.taskSha256);
      const task = json(built.bundleDir, `records/${pinned.taskSha256}.bin`);
      const specSha256 = task["evaluation"]["digest"]["sha256"] as string;
      expect(rolesOf(specSha256), pinned.name).toEqual(["evaluation-spec"]);
      const spec = parseEvaluationSpec(new Uint8Array(readFileSync(join(built.bundleDir, `records/${specSha256}.bin`))));
      expect(spec.family, pinned.name).toBe("external-verifier");
      expect((spec.grader as { name?: string }).name, pinned.name).toBe(`terminal-bench/${pinned.name}`);
    }
  }, 300_000);

  test("the sealed rule gives the verdicts: a reward that is neither 0 nor 1 is left out of the rate, not counted as a fail", async () => {
    const built = await slate();
    // Imported rewards: oracle 1, 1, 1; terminus-2 1, 0, and one half. The half is inconclusive
    // under the sealed rule, so it leaves that arm's rate at one pass of two judged cells. Counted
    // as a fail it would have been one of three.
    const headline = json(built.bundleDir, "claim-package.json")["headline"] as Record<string, { n: number; passRate: string }>;
    expect(headline["oracle"]).toMatchObject({ n: 3, passRate: "1.0000" });
    expect(headline["terminus-2"]).toMatchObject({ n: 2, passRate: "0.5000" });
    // Every slot is still accounted for.
    const matrix = json(built.bundleDir, "matrix.json") as { completeness: Record<string, unknown> };
    expect(matrix.completeness).toMatchObject({ expected: 6, judged: 6 });
  }, 300_000);

  test("the same bundle with the capability dropped from the vector is refused", async () => {
    const built = await slate();
    const undeclared = detach(built.bundleDir, "slate-undeclared");
    redeclare(undeclared, ["external-import", "owner-controlled-publication"]);
    expect(await refusal(undeclared)).toEqual({
      path: "bundle.manifest.capabilities",
      message: expect.stringContaining("a brought run on the official slate cannot pass without it"),
    });
  }, 300_000);
});
