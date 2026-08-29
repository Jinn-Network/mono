// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { parseCellKey, parseMatrix, parseReport } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import { verifyPublicBundle } from "@colophon-claims/check";
import { createSyntheticV4BundleFixture } from "../bundle/testing/v4-synthetic-fixture.js";
import { readVerdictEnvelope } from "../venue/signing.js";

const optedIn = process.env.COLOPHON_T1_REGISTRY_URL !== undefined;
const repositoryRoot = resolve(fileURLToPath(new URL("../../../../../", import.meta.url)));
const roots: string[] = [];
const CHECKS = [
  "manifest",
  "evidence-closure",
  "trust",
  "matrix-rederivation",
  "report-verification",
  "claim-consistency",
] as const;
const DISPUTED_ITEM_ID = "urn:uuid:40000000-0000-4000-8000-000000000000";
const T1_ITEM_IDS = [
  "urn:uuid:40000000-0000-4000-8000-000000000001",
  "urn:uuid:40000000-0000-4000-8000-000000000002",
  "urn:uuid:40000000-0000-4000-8000-000000000003",
  "urn:uuid:40000000-0000-4000-8000-000000000004",
  "urn:uuid:40000000-0000-4000-8000-000000000005",
  "urn:uuid:40000000-0000-4000-8000-000000000006",
  "urn:uuid:40000000-0000-4000-8000-000000000007",
  "urn:uuid:40000000-0000-4000-8000-000000000008",
  "urn:uuid:40000000-0000-4000-8000-000000000009",
  "urn:uuid:40000000-0000-4000-8000-000000000010",
  "urn:uuid:40000000-0000-4000-8000-000000000011",
  "urn:uuid:40000000-0000-4000-8000-000000000012",
] as const;
const CELL_TABLE = [
  ["AAA", "RRR", "AAA", "AAA"],
  ["RRR", "AAA", "RRR", "RRR"],
  ["AAA", "AAR", "AAA", "AAA"],
  ["RRR", "RRR", "IRR", "RRR"],
  ["AAA", "AAA", "AAA", "RRR"],
  ["RRR", "RRR", "RRR", "AAA"],
  ["AAA", "AAA", "AAA", "AAR"],
  ["RRR", "RRR", "RRR", "RRR"],
  ["AAA", "AAA", "AAA", "AAA"],
  ["RRR", "RRR", "RRR", "RRR"],
  ["AAA", "AAA", "AAA", "AAA"],
  ["RRR", "RRR", "RRR", "RRX"],
] as const;
const ARM_IDS = ["alpha", "beta", "delta", "gamma"] as const;
const VERIFY_FIRST_PARTY_CLOSURE = [
  "@colophon-claims/check",
  "@jinn-network/benchmarking-aggregate",
  "@jinn-network/benchmarking-interop",
  "@jinn-network/benchmarking-local",
  "@jinn-network/benchmarking-records",
  "@jinn-network/benchmarking-run",
  "@jinn-network/environment-record",
  "@jinn-network/task-admission",
  "@jinn-network/task-execution-profiles",
  "@jinn-network/task-execution-protocol",
  "@jinn-network/trust-core",
] as const;

interface ProjectionExpectation {
  readonly item: readonly [expected: number, complete: number, excluded: number, unstable: number];
  readonly call: readonly [expected: number, evaluated: number, parseInvalid: number];
  readonly confusion: readonly [correctAccepted: number, correctRejected: number, wrongAccepted: number, wrongRejected: number];
  readonly rates: readonly [
    agreement: readonly [number, number],
    falseAccept: readonly [number, number],
    falseReject: readonly [number, number],
    instability: readonly [number, number],
    parserInvalid: readonly [number, number],
  ];
}

const WHOLE: Readonly<Record<string, ProjectionExpectation>> = {
  alpha: { item: [12, 12, 0, 0], call: [36, 36, 0], confusion: [6, 0, 0, 6], rates: [[12, 12], [0, 6], [0, 6], [0, 12], [0, 36]] },
  beta: { item: [12, 12, 0, 1], call: [36, 36, 0], confusion: [5, 1, 1, 5], rates: [[10, 12], [1, 6], [1, 6], [1, 12], [0, 36]] },
  delta: { item: [12, 12, 0, 0], call: [36, 36, 1], confusion: [6, 0, 0, 6], rates: [[12, 12], [0, 6], [0, 6], [0, 12], [1, 36]] },
  gamma: { item: [12, 11, 1, 1], call: [36, 35, 0], confusion: [5, 1, 1, 4], rates: [[9, 11], [1, 5], [1, 6], [1, 11], [0, 35]] },
};

const CORE: Readonly<Record<string, ProjectionExpectation>> = {
  alpha: { item: [6, 6, 0, 0], call: [18, 18, 0], confusion: [3, 0, 0, 3], rates: [[6, 6], [0, 3], [0, 3], [0, 6], [0, 18]] },
  beta: { item: [6, 6, 0, 1], call: [18, 18, 0], confusion: [2, 1, 1, 2], rates: [[4, 6], [1, 3], [1, 3], [1, 6], [0, 18]] },
  delta: { item: [6, 6, 0, 0], call: [18, 18, 1], confusion: [3, 0, 0, 3], rates: [[6, 6], [0, 3], [0, 3], [0, 6], [1, 18]] },
  gamma: { item: [6, 6, 0, 0], call: [18, 18, 0], confusion: [2, 1, 1, 2], rates: [[4, 6], [1, 3], [1, 3], [0, 6], [0, 18]] },
};

const STRESS: Readonly<Record<string, ProjectionExpectation>> = {
  alpha: { item: [6, 6, 0, 0], call: [18, 18, 0], confusion: [3, 0, 0, 3], rates: [[6, 6], [0, 3], [0, 3], [0, 6], [0, 18]] },
  beta: { item: [6, 6, 0, 0], call: [18, 18, 0], confusion: [3, 0, 0, 3], rates: [[6, 6], [0, 3], [0, 3], [0, 6], [0, 18]] },
  delta: { item: [6, 6, 0, 0], call: [18, 18, 0], confusion: [3, 0, 0, 3], rates: [[6, 6], [0, 3], [0, 3], [0, 6], [0, 18]] },
  gamma: { item: [6, 5, 1, 1], call: [18, 17, 0], confusion: [3, 0, 0, 2], rates: [[5, 5], [0, 2], [0, 3], [1, 5], [0, 17]] },
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function fixedRate([numerator, denominator]: readonly [number, number]) {
  return { numerator, denominator, estimate: denominator === 0 ? null : (numerator / denominator).toFixed(4) };
}

function projectionFacts(value: Record<string, any>) {
  return {
    item: value.item,
    call: value.call,
    confusion: value.confusion,
    agreement: value.agreement,
    falseAccept: value.falseAccept,
    falseReject: value.falseReject,
    instability: value.instability,
    parserInvalid: value.parserInvalid,
  };
}

function expectProjection(actual: Record<string, any>, expected: ProjectionExpectation): void {
  const [itemExpected, complete, excluded, unstable] = expected.item;
  const [callExpected, evaluated, parseInvalid] = expected.call;
  const [correctAccepted, correctRejected, wrongAccepted, wrongRejected] = expected.confusion;
  expect(projectionFacts(actual)).toMatchObject({
    item: { expected: itemExpected, complete, excluded, unstable },
    call: { expected: callExpected, evaluated, parseInvalid },
    confusion: { correctAccepted, correctRejected, wrongAccepted, wrongRejected },
    agreement: fixedRate(expected.rates[0]),
    falseAccept: fixedRate(expected.rates[1]),
    falseReject: fixedRate(expected.rates[2]),
    instability: fixedRate(expected.rates[3]),
    parserInvalid: fixedRate(expected.rates[4]),
  });
}

function evidenceRecordBytes(bundleDir: string, evidence: Record<string, any>, role: string): Uint8Array {
  const record = (evidence.records as Array<{ sha256: string; roles: string[] }>)
    .find((entry) => entry.roles.includes(role));
  if (record === undefined) throw new Error(`cold lifecycle bundle carries no ${role} record`);
  return readFileSync(join(bundleDir, "records", `${record.sha256}.bin`));
}

function evidenceRecordsForRole(bundleDir: string, evidence: Record<string, any>, role: string): Uint8Array[] {
  return (evidence.records as Array<{ sha256: string; roles: string[] }>)
    .filter((entry) => entry.roles.includes(role))
    .map((entry) => readFileSync(join(bundleDir, "records", `${entry.sha256}.bin`)));
}

function run(command: string, args: readonly string[], options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv }) {
  return new Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>((resolvePromise, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise({
      exitCode: code ?? -1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function assertRealTree(path: string): void {
  const metadata = lstatSync(path);
  expect(metadata.isSymbolicLink(), path).toBe(false);
  expect(metadata.isDirectory() || metadata.isFile(), path).toBe(true);
  if (metadata.isDirectory()) {
    for (const entry of readdirSync(path)) assertRealTree(join(path, entry));
  }
}

describe("T1 provider-free binary qualification cold lifecycle", () => {
  test.skipIf(!optedIn)("survives builder deletion and a packed verify@0.1-only replay", async () => {
    const registryUrl = process.env.COLOPHON_T1_REGISTRY_URL!;
    const parsedRegistryUrl = new URL(registryUrl);
    expect(parsedRegistryUrl.hostname).toBe("127.0.0.1");
    expect(parsedRegistryUrl.username).toBe("");
    expect(parsedRegistryUrl.password).toBe("");
    const root = mkdtempSync(join(tmpdir(), "colophon-t1-cold-"));
    roots.push(root);
    const workspaceDir = join(root, "builder-workspace");
    const copiedBundleDir = join(root, "cold-bundle");
    const coldReaderDir = join(root, "cold-reader");

    const fixture = await createSyntheticV4BundleFixture({
      workspaceDir,
      truthAdmission: "two-human-unanimous",
      scenario: "qualification-144",
    });
    expect(fixture.publicationGrade).toBe(true);
    expect(fixture.taskSha256s).toHaveLength(12);
    cpSync(fixture.bundle.bundleDir, copiedBundleDir, { recursive: true });

    const matrix = parseMatrix(readFileSync(join(copiedBundleDir, "matrix.json")));
    const report = parseReport(readFileSync(join(copiedBundleDir, "report.json")));
    const qualificationBundle = json(join(copiedBundleDir, "qualification.json"));
    const evidence = json(join(copiedBundleDir, "evidence.json"));
    const claim = json(join(copiedBundleDir, "claim-package.json"));
    const result = (report.results as Record<string, any>).perSubject?.[0]?.results as Record<string, any> | undefined;
    if (result === undefined) throw new Error("binary qualification Report carries no per-subject result");
    const itemBankBytes = evidenceRecordBytes(copiedBundleDir, evidence, "item-bank");
    const itemBankRows = Buffer.from(itemBankBytes).toString("utf8").trimEnd().split("\n")
      .map((line) => JSON.parse(line) as { item: Record<string, any> });
    expect(itemBankRows.map((row) => row.item.itemId)).toEqual([DISPUTED_ITEM_ID, ...T1_ITEM_IDS]);
    const authoredById = new Map(itemBankRows.map((row) => [String(row.item.itemId), row.item]));
    const itemDigestById = new Map(itemBankRows.map((row) => [String(row.item.itemId), recordDigest(canonicalJsonBytes(row.item))]));
    const qualificationItemByTask = new Map<string, { readonly itemId: string; readonly index: number }>();
    const contextCounts = { core: 0, stress: 0 };
    for (const entry of qualificationBundle.items as Array<Record<string, string>>) {
      const item = JSON.parse(Buffer.from(readFileSync(join(
        copiedBundleDir,
        "records",
        `${entry.itemSha256.slice("sha256:".length)}.bin`,
      ))).toString("utf8")) as Record<string, any>;
      const index = T1_ITEM_IDS.indexOf(item.itemId as typeof T1_ITEM_IDS[number]);
      expect(index, item.itemId).toBeGreaterThanOrEqual(0);
      expect(entry.itemSha256).toBe(itemDigestById.get(item.itemId));
      const analysis = JSON.parse(Buffer.from(readFileSync(join(
        copiedBundleDir,
        "records",
        `${entry.analysisContextSha256.slice("sha256:".length)}.bin`,
      ))).toString("utf8")) as Record<string, any>;
      const expectedTruth = index % 2 === 0 ? "CORRECT" : "WRONG";
      const expectedStratum = index < 6 ? "core" : "stress";
      expect(analysis).toMatchObject({
        itemId: item.itemId,
        itemSha256: entry.itemSha256,
        truthLabel: expectedTruth,
        candidateClass: "synthetic",
        stratum: expectedStratum,
        labelResolutionSha256: entry.labelResolutionSha256,
      });
      contextCounts[expectedStratum] += 1;
      qualificationItemByTask.set(entry.taskSha256.slice("sha256:".length), { itemId: item.itemId, index });
    }
    expect([...qualificationItemByTask.values()].map((entry) => entry.itemId).sort()).toEqual([...T1_ITEM_IDS].sort());
    expect(contextCounts).toEqual({ core: 6, stress: 6 });

    const disputedItemSha256 = itemDigestById.get(DISPUTED_ITEM_ID)!;
    const replacementItemSha256 = itemDigestById.get(T1_ITEM_IDS[0])!;
    expect(qualificationBundle.exclusions).toEqual([{
      itemSha256: disputedItemSha256,
      replacementItemSha256,
      reason: "review-disagreement",
    }]);
    const replacementLedger = JSON.parse(Buffer.from(evidenceRecordBytes(
      copiedBundleDir,
      evidence,
      "replacement-ledger",
    )).toString("utf8")) as Record<string, any>;
    expect(replacementLedger.entries).toHaveLength(1);
    expect(replacementLedger.entries[0]).toMatchObject({
      excludedItemSha256: disputedItemSha256,
      replacementItemSha256,
      excludedPoolPosition: 1,
      replacementPoolPosition: 2,
      candidateClass: "synthetic",
      stratum: "core",
      reason: "review-disagreement",
    });
    const reviewResponses = evidenceRecordsForRole(copiedBundleDir, evidence, "human-review-response")
      .map((bytes) => JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, any>);
    const labelsFor = (itemSha256: string) => reviewResponses
      .filter((response) => response.itemSha256 === itemSha256)
      .sort((left, right) => String(left.evaluatorId) < String(right.evaluatorId) ? -1 : 1)
      .map((response) => [response.evaluatorId, response.label, response.complete]);
    expect(labelsFor(disputedItemSha256)).toEqual([
      ["urn:jinn:reviewer:a", "CORRECT", true],
      ["urn:jinn:reviewer:b", "WRONG", true],
    ]);
    for (const [index, itemId] of T1_ITEM_IDS.entries()) {
      const expectedTruth = index % 2 === 0 ? "CORRECT" : "WRONG";
      expect(labelsFor(itemDigestById.get(itemId)!)).toEqual([
        ["urn:jinn:reviewer:a", expectedTruth, true],
        ["urn:jinn:reviewer:b", expectedTruth, true],
      ]);
    }
    expect(authoredById.has(DISPUTED_ITEM_ID)).toBe(true);

    expect(matrix.cells).toHaveLength(144);
    expect(matrix.completeness).toMatchObject({ expected: 144, judged: 143, runOutcome: "partial" });
    expect(matrix.attrition.asymmetryFlags).toEqual(["nonjudged-arm-imbalance"]);
    expect(matrix.attrition.perArm.gamma).toMatchObject({ expected: 36, judged: 35, unscorable: 1, replacements: 0 });
    for (const armId of ["alpha", "beta", "delta"]) {
      expect(matrix.attrition.perArm[armId]).toMatchObject({ expected: 36, judged: 36, unscorable: 0, replacements: 0 });
    }
    expect(Object.values(matrix.attrition.perArm).every((arm) => arm.replacements === 0)).toBe(true);
    const observedCoordinates = new Set<string>();
    for (const cell of matrix.cells) {
      const coordinate = parseCellKey(cell.cellKey);
      const item = qualificationItemByTask.get(coordinate.taskDigest);
      if (item === undefined) throw new Error(`Matrix Task ${coordinate.taskDigest} is outside the frozen T1 item set`);
      const armIndex = ARM_IDS.indexOf(coordinate.armId as typeof ARM_IDS[number]);
      expect(armIndex, coordinate.armId).toBeGreaterThanOrEqual(0);
      const expected = CELL_TABLE[item.index]![armIndex]![coordinate.replicate - 1];
      observedCoordinates.add(`${item.itemId}/${coordinate.armId}/${coordinate.replicate}`);
      if (expected === "X") {
        expect(cell).toMatchObject({ outcome: "unscorable", verdicts: [], validVerdicts: [] });
        continue;
      }
      expect(cell.outcome).toBe("judged");
      expect(cell.validVerdicts).toHaveLength(1);
      const verdictSha256 = cell.validVerdicts[0]!.slice("sha256:".length);
      const verdict = readVerdictEnvelope(readFileSync(join(copiedBundleDir, "records", `${verdictSha256}.bin`)));
      expect(verdict.measurements.judgeDecision).toBe(expected === "A" ? "ACCEPT" : "REJECT");
      expect(verdict.measurements.parseValid).toBe(expected !== "I");
    }
    expect(observedCoordinates.size).toBe(144);

    expect(Object.keys(result.arms)).toEqual(["alpha", "beta", "delta", "gamma"]);
    for (const armId of Object.keys(WHOLE)) {
      const arm = result.arms[armId] as Record<string, any>;
      expectProjection(arm, WHOLE[armId]!);
      expectProjection(arm.byStratum.core, CORE[armId]!);
      expectProjection(arm.byStratum.stress, STRESS[armId]!);
      expect(projectionFacts(arm.byCandidateClass.synthetic)).toEqual(projectionFacts(arm));
    }
    expect(result.excluded).toMatchObject({ count: 1, items: [expect.objectContaining({
      armId: "gamma",
      reasons: [expect.objectContaining({ reason: "cell-not-judged" })],
    })] });
    expect(result.itemDecisions).toHaveLength(47);
    expect(result.itemDecisions.filter((item: { unstable: boolean }) => item.unstable)).toHaveLength(2);
    expect(claim.qualification).toEqual(result);

    expect(qualificationBundle).toMatchObject({
      publicationGrade: true,
      truthAdmission: "two-human-unanimous",
      candidateClasses: ["synthetic"],
      strata: ["core", "stress"],
      exclusions: [expect.objectContaining({ reason: "review-disagreement" })],
    });
    expect(qualificationBundle.items).toHaveLength(12);
    expect(qualificationBundle.exclusions).toHaveLength(1);
    expect(itemBankRows).toHaveLength(13);
    expect(Buffer.from(evidenceRecordBytes(copiedBundleDir, evidence, "admission-index"))
      .toString("utf8").trimEnd().split("\n")).toHaveLength(12);
    const benchmark = json(join(copiedBundleDir, "benchmark.json"));
    expect(benchmark.items).toHaveLength(12);

    const sourceBytes = Buffer.concat([
      Buffer.from(itemBankBytes),
      Buffer.from(evidenceRecordBytes(copiedBundleDir, evidence, "source-manifest")),
      ...qualificationBundle.arms.map((arm: { instrumentSha256: string }) =>
        readFileSync(join(copiedBundleDir, "records", `${arm.instrumentSha256.slice("sha256:".length)}.bin`))),
    ]);
    const scientificText = sourceBytes.toString("utf8");
    expect(scientificText).not.toMatch(/locomo|snap-research|dial481|backboard|mem0|evermemos/iu);
    for (const match of scientificText.matchAll(/https?:\/\/[^"\\\s]+/gu)) {
      const uri = new URL(match[0]);
      expect(uri.protocol).toBe("https:");
      expect(uri.hostname).toMatch(/^(?:fixtures\.example\.test|spec\.jinn\.network)$/u);
    }
    const publicBytes = Buffer.concat((json(join(copiedBundleDir, "bundle.json")).files as Array<{ path: string }>).map((file) =>
      readFileSync(join(copiedBundleDir, file.path))));
    expect(publicBytes.includes(Buffer.from(workspaceDir))).toBe(false);
    expect(publicBytes.includes(Buffer.from(repositoryRoot))).toBe(false);

    const initial = await verifyPublicBundle(copiedBundleDir);
    expect(initial).toMatchObject({
      format: "benchmark-product-public-bundle/4",
      checks: CHECKS,
      qualification: { publicationGrade: true, itemCount: 12, exclusionCount: 1 },
    });
    const identity = initial.identity;
    rmSync(workspaceDir, { recursive: true, force: true });
    expect(existsSync(workspaceDir)).toBe(false);

    mkdirSync(coldReaderDir);
    writeFileSync(join(coldReaderDir, "package.json"), JSON.stringify({
      private: true,
      dependencies: { "@colophon-claims/check": "0.1" },
    }, null, 2), { flag: "wx" });
    writeFileSync(join(coldReaderDir, ".npmrc"), [
      `registry=${registryUrl}`,
      `@colophon-claims:registry=${registryUrl}`,
      `@jinn-network:registry=${registryUrl}`,
      "audit=false",
      "fund=false",
      "",
    ].join("\n"));
    const npmCache = join(root, "npm-cache");
    const minimalEnv = {
      PATH: process.env.PATH ?? "",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      npm_config_cache: npmCache,
      npm_config_userconfig: join(coldReaderDir, ".npmrc"),
    };
    const installed = await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", npmCache], {
      cwd: coldReaderDir,
      env: minimalEnv,
    });
    expect(installed.exitCode, installed.stderr).toBe(0);
    const installedVerifier = join(coldReaderDir, "node_modules", "@colophon-claims", "verify");
    expect(statSync(installedVerifier).isDirectory()).toBe(true);
    expect(statSync(installedVerifier).isSymbolicLink()).toBe(false);
    expect(json(join(installedVerifier, "package.json")).version).toMatch(/^2\./u);
    const lockBytes = readFileSync(join(coldReaderDir, "package-lock.json"), "utf8");
    expect(lockBytes).not.toContain("portal:");
    expect(lockBytes).not.toContain(workspaceDir);
    expect(lockBytes).not.toContain(repositoryRoot);
    const lock = JSON.parse(lockBytes) as { packages?: Record<string, unknown> };
    const firstPartyLocations = Object.keys(lock.packages ?? {}).filter((location) =>
      /(?:^|\/)node_modules\/(?:@colophon-claims|@jinn-network)\/[^/]+$/u.test(location));
    expect(firstPartyLocations.length).toBeGreaterThan(1);
    const installedFirstPartyNames = firstPartyLocations.map((location) => {
      const packagePath = join(coldReaderDir, location);
      assertRealTree(packagePath);
      return String(json(join(packagePath, "package.json")).name);
    }).sort();
    expect([...new Set(installedFirstPartyNames)]).toEqual(VERIFY_FIRST_PARTY_CLOSURE);

    expect(existsSync(workspaceDir)).toBe(false);
    const executable = join(coldReaderDir, "node_modules", ".bin", process.platform === "win32" ? "colophon-check.cmd" : "colophon-check");
    const replay = await run(executable, [copiedBundleDir, "--json"], {
      cwd: coldReaderDir,
      env: minimalEnv,
    });
    expect(replay.exitCode, replay.stderr).toBe(0);
    const verified = JSON.parse(replay.stdout) as Record<string, any>;
    expect(verified).toMatchObject({
      ok: true,
      verifierVersion: expect.stringMatching(/^2\./u),
      format: "benchmark-product-public-bundle/4",
      identity,
      checks: CHECKS,
    });
    expect(existsSync(workspaceDir)).toBe(false);
  }, 180_000);
});
