// SPDX-License-Identifier: MIT

/**
 * The CLI's behavior, as golden output where the output is the contract.
 *
 * Every case builds its campaign directory through the *real* C7a/C7b surfaces — `createCampaign`,
 * `planWave`, the real sealers — so a golden `status` block is a rendering of a journal the product
 * actually wrote, not of a hand-typed fixture that could drift from what the journal can contain.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalTupleBytes,
  prefixedDigest,
  tupleDigest,
  EXECUTION_TUPLE_FORMAT_TOKEN,
} from "@jinn-network/policy-identity";
import { openCampaign } from "../journal-store.js";
import { decideAllocation } from "../allocation.js";
import { planWave } from "../wave.js";
import {
  allocationDecidedPayload, appendWaveEvent, runSealedPayload, wavePlannedPayload,
} from "../wave-journal.js";
import { NO_CELLS_COMMITTED } from "../wave-types.js";
import { manifestFor, lineagePair } from "../testing/archive-fixtures.js";
import {
  benchmarkFor, campaignFor, candidateFor, runSettings, tasksFor, tupleFor,
} from "../testing/wave-fixtures.js";
import { runCli } from "./main.js";
import type { CliContext } from "./result.js";

const NOW = "2026-08-04T00:00:00Z";
const PROFILE = "https://profiles.jinn.network/repository-work/1.0";

let root: string;
let context: CliContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jinn-cli-"));
  context = { cwd: root, now: () => NOW };
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function write(name: string, value: unknown): string {
  const path = join(root, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return path;
}

function writeBytes(name: string, bytes: Uint8Array): string {
  const path = join(root, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

const TASKS = tasksFor(["fix the failing test", "add the missing guard"]);
const DEV = benchmarkFor({ name: "dev-slate", tasks: TASKS, reveal: { policy: "immediate" } });
const PROMOTION = benchmarkFor({
  name: "promotion-slate",
  tasks: tasksFor(["the held-out one"]),
  reveal: { policy: "after-run" },
});
const SEED = candidateFor("seed", "repo-work-seed", "1");
const RIVAL = candidateFor("rival", "repo-work-rival", "2");

function campaignDocument() {
  return campaignFor({
    developmentBenchmark: DEV.digest,
    promotionBenchmark: PROMOTION.digest,
    seeds: [SEED],
    allocation: { policyRef: "uniform/1.0", parameters: {} },
  });
}

/** Creates a campaign through the CLI and returns its directory. */
function createThroughCli(): { readonly directory: string; readonly stdout: string } {
  write("campaign.json", campaignDocument());
  write("seed.json", { ...SEED.tuple });
  const result = runCli([
    "optimize", "campaign", "create",
    "--dir", "campaign", "--document", "campaign.json", "--seed", "seed.json",
  ], context);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return { directory: join(root, "campaign"), stdout: result.stdout };
}

describe("optimize campaign create", () => {
  it("seals the document with its seed referents and reports the campaign digest", () => {
    const { stdout, directory } = createThroughCli();
    const digest = prefixedDigest(new Uint8Array(readFileSync(join(directory, "campaign.json"))));
    expect(stdout).toBe([
      `campaign  ${digest}`,
      `directory ${directory}`,
      "seeds     1",
      "phase     DRAFT",
      "",
    ].join("\n"));
  });

  it("discriminates a seed by its own formatToken rather than by a hand-written kind", () => {
    const seed = manifestFor({ name: "manifest-seed", fill: "1" });
    // Same tuple as SEED, arriving as a candidate manifest instead of a bare tuple.
    expect(prefixedDigest(canonicalTupleBytes(seed.manifest.policy)))
      .toBe(tupleDigest(tupleFor("manifest-seed", "1")));
    // The campaign names the seed by its **manifest** digest; the CLI reads the kind off the file.
    write("campaign.json", {
      ...campaignFor({
        developmentBenchmark: DEV.digest,
        promotionBenchmark: PROMOTION.digest,
        seeds: [candidateFor("seed", "manifest-seed", "1")],
        allocation: { policyRef: "uniform/1.0", parameters: {} },
      }),
      seeds: [{ kind: "candidate", digest: seed.digest }],
    });
    writeBytes("seed-manifest.json", seed.bytes);
    const result = runCli([
      "optimize", "campaign", "create",
      "--dir", "campaign", "--document", "campaign.json", "--seed", "seed-manifest.json",
    ], context);
    expect(result.exitCode).toBe(0);
  });

  it("refuses a seed file carrying no recognized format token", () => {
    write("campaign.json", campaignDocument());
    write("junk.json", { hello: "world" });
    const result = runCli([
      "optimize", "campaign", "create",
      "--dir", "campaign", "--document", "campaign.json", "--seed", "junk.json",
    ], context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("seed-resolution");
  });

  it("refuses with no seeds — the frozen-axis check is uncomputable without referents", () => {
    write("campaign.json", campaignDocument());
    const result = runCli([
      "optimize", "campaign", "create", "--dir", "campaign", "--document", "campaign.json",
    ], context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--seed");
  });
});

describe("optimize campaign status", () => {
  it("renders a fresh campaign's journal replay", () => {
    const { directory } = createThroughCli();
    const digest = prefixedDigest(new Uint8Array(readFileSync(join(directory, "campaign.json"))));
    const result = runCli(["optimize", "campaign", "status", "--dir", "campaign"], context);
    expect(result.stdout).toBe([
      `campaign     ${digest}`,
      "phase        DRAFT",
      "entries      1",
      `recorded     ${NOW}`,
      "development  0 / 200 cells",
      "promotion    0 cells",
      "hard cap     0 / 260 cells",
      "arms         0",
      "",
    ].join("\n"));
  });

  it("renders phase, spend, and the arms of the latest planned wave", () => {
    const { directory } = createThroughCli();
    seedAWave(directory);
    const digest = prefixedDigest(new Uint8Array(readFileSync(join(directory, "campaign.json"))));
    const result = runCli(["optimize", "campaign", "status", "--dir", "campaign"], context);
    expect(result.stdout).toBe([
      `campaign     ${digest}`,
      "phase        EXPLORING",
      "entries      4",
      `recorded     ${NOW}`,
      "development  4 / 200 cells",
      "promotion    0 cells",
      "hard cap     4 / 260 cells",
      "arms         2",
      // Arm order is the plan's, which orders by tuple digest — not by admission and not by name.
      `  ${RIVAL.armId}  ${RIVAL.tupleDigest}  wave 1`,
      `  ${SEED.armId}  ${SEED.tupleDigest}  wave 1`,
      "",
    ].join("\n"));
  });

  it("refuses a directory holding no campaign", () => {
    const result = runCli(["optimize", "campaign", "status", "--dir", "nowhere"], context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("journal-integrity");
  });
});

/** Plans and journals one wave through the real C7b surfaces, so `status` renders real payloads. */
function seedAWave(directory: string): void {
  const handle = openCampaign(directory);
  const candidates = [SEED, RIVAL];
  const allocation = decideAllocation({
    campaign: handle.campaign,
    waveNumber: 1,
    population: candidates,
    taskDigests: DEV.record.items.map((item) => item.task.digest.sha256),
  });
  const plan = planWave({
    campaign: handle.campaign,
    campaignDigest: handle.digest,
    waveNumber: 1,
    candidates,
    allocation,
    developmentBenchmarkBytes: DEV.bytes,
    settings: runSettings(),
    committed: NO_CELLS_COMMITTED,
  });
  // Wave 1 crosses DRAFT -> EXPLORING, so `wave-planned` comes first (F-C7d-5).
  let next = appendWaveEvent(handle, {
    type: "wave-planned", recordedAt: NOW, payload: wavePlannedPayload(plan),
  }, { exploringEntry: {
    benchmarkBytes: PROMOTION.bytes,
    revealContext: { kind: "after-run", trustedRunNotClosed: true },
  } });
  next = appendWaveEvent(next, {
    type: "allocation-decided", recordedAt: NOW, payload: allocationDecidedPayload(allocation),
  });
  appendWaveEvent(next, {
    type: "run-sealed", recordedAt: NOW, payload: runSealedPayload(plan),
  });
}

describe("optimize campaign run", () => {
  it("decides, plans, seals, journals — and says plainly that it cannot dispatch", () => {
    const { directory } = createThroughCli();
    writeBytes("dev.json", DEV.bytes);
    writeBytes("promotion.json", PROMOTION.bytes);
    write("settings.json", runSettings());
    write("candidates.json", [SEED, RIVAL].map((candidate) => ({
      armId: candidate.armId, tuple: candidate.tuple, source: candidate.source,
    })));

    const result = runCli([
      "optimize", "campaign", "run",
      "--dir", "campaign", "--settings", "settings.json", "--benchmark", "dev.json",
      "--candidates", "candidates.json",
      "--promotion-benchmark", "promotion.json", "--trusted-run-not-closed",
    ], context);

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("wave         1 (development)");
    expect(result.stdout).toContain("phase        EXPLORING");
    expect(result.stdout).toContain("allocation   uniform/1.0: 2 retained, 0 pruned");
    expect(result.stdout).toContain("cells        4");
    expect(result.stdout).toContain("Not dispatched.");
    expect(result.stdout).toContain("TaskExecutionBackend binding");

    // The sealed records land on disk, so a host that holds a backend can execute exactly this Run.
    const runBytes = readFileSync(join(directory, "waves", "1", "run.json"));
    expect(JSON.parse(runBytes.toString("utf8")).benchmark.digest.sha256).toBeTypeOf("string");
    expect(runCli(["optimize", "campaign", "status", "--dir", "campaign"], context).stdout)
      .toContain("phase        EXPLORING");
  });

  // §6.3: the DRAFT -> EXPLORING crossing needs the promotion Benchmark committed and unrevealed.
  it("refuses the first wave without the promotion Benchmark and a reveal moment", () => {
    createThroughCli();
    writeBytes("dev.json", DEV.bytes);
    write("settings.json", runSettings());
    write("candidates.json", [{ armId: SEED.armId, tuple: SEED.tuple }]);
    const result = runCli([
      "optimize", "campaign", "run",
      "--dir", "campaign", "--settings", "settings.json", "--benchmark", "dev.json",
      "--candidates", "candidates.json",
    ], context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("promotion-benchmark");
  });

  it("refuses a wave with no admitted candidates", () => {
    createThroughCli();
    writeBytes("dev.json", DEV.bytes);
    write("settings.json", runSettings());
    write("candidates.json", []);
    const result = runCli([
      "optimize", "campaign", "run",
      "--dir", "campaign", "--settings", "settings.json", "--benchmark", "dev.json",
      "--candidates", "candidates.json",
    ], context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("wave-composition");
  });
});

describe("optimize candidate inspect", () => {
  it("parses, validates, and reports the tuple and declared payload classes", () => {
    const candidate = manifestFor({
      name: "candidate", fill: "3", touchedComponents: ["skills/repo-work", "hooks/pre.sh"],
    });
    writeBytes("candidate.json", candidate.bytes);
    const result = runCli(["optimize", "candidate", "inspect", "--manifest", "candidate.json"], context);
    expect(result.stdout).toBe([
      `manifest     ${candidate.digest}`,
      `tuple        ${prefixedDigest(canonicalTupleBytes(candidate.manifest.policy))}`,
      `proposer     ${candidate.manifest.proposer}`,
      "parents      none (a seed)",
      "changes      Fixture candidate candidate.",
      "payload      hook, skill (declared, not verified)",
      "lineage      not projected (pass --population <dir>)",
      "",
    ].join("\n"));
  });

  it("places the candidate in a population directory's lineage", () => {
    const { seed, child } = lineagePair();
    mkdirSync(join(root, "population"), { recursive: true });
    writeBytes(join("population", "seed.json"), seed.bytes);
    writeBytes(join("population", "child.json"), child.bytes);
    const result = runCli([
      "optimize", "candidate", "inspect",
      "--manifest", join("population", "child.json"), "--population", "population",
    ], context);
    expect(result.stdout).toContain("population   2 manifests");
    expect(result.stdout).toContain(`ancestors    ${seed.digest}`);
    expect(result.stdout).toContain("descendants  none");
    expect(result.stdout).toContain("same tuple   none");
  });

  it("names an unresolved typed parent rather than hiding it", () => {
    const absent = `sha256:${"e".repeat(64)}`;
    const orphan = manifestFor({
      name: "orphan", fill: "4", parents: [{ kind: "candidate", digest: absent }],
    });
    mkdirSync(join(root, "population"), { recursive: true });
    writeBytes(join("population", "orphan.json"), orphan.bytes);
    const result = runCli([
      "optimize", "candidate", "inspect",
      "--manifest", join("population", "orphan.json"), "--population", "population",
    ], context);
    expect(result.stdout).toContain(`unresolved   candidate:${absent}`);
  });

  it("refuses bytes that are not an exact canonical candidate manifest", () => {
    write("not-a-manifest.json", { formatToken: "network.jinn.policy.candidate/1.0" });
    const result = runCli([
      "optimize", "candidate", "inspect", "--manifest", "not-a-manifest.json",
    ], context);
    expect(result.exitCode).toBe(1);
  });
});

describe("optimize policy adopt / rollback", () => {
  const adoptArgs = (candidate: string, ...extra: string[]) => [
    "optimize", "policy", "adopt", "--dir", "campaign", "--candidate", candidate,
    "--task-profile", PROFILE, ...extra,
  ];

  function preparedCampaign(): string {
    const { directory } = createThroughCli();
    return directory;
  }

  it("records the adoption, labels the file, and prints a config fragment", () => {
    preparedCampaign();
    write("tuple.json", { ...tupleFor("adopted", "5") });
    const result = runCli(adoptArgs("tuple.json"), context);

    expect(result.exitCode).toBe(0);
    const digest = prefixedDigest(canonicalTupleBytes(tupleFor("adopted", "5")));
    expect(result.stdout).toContain(`adopted      ${digest}`);
    expect(result.stdout).toContain("displaced    nothing — this scope had no adoption");
    expect(result.stdout).toContain("not re-derivable — keep it");
    expect(result.stdout).toContain("Pin this in your operator config (nothing was changed for you)");

    const log = JSON.parse(readFileSync(join(root, "campaign", "archive", "adoption.json"), "utf8"));
    expect(log.nonDerivable).toBe(true);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]).toMatchObject({
      tupleDigest: digest, adoptedAt: NOW, priorTuple: null,
      scope: { taskProfile: PROFILE },
    });
  });

  // §7.4: consenting to a prompt is not consenting to arbitrary code execution.
  it("refuses a hook-bearing candidate whose class was not approved by name", () => {
    preparedCampaign();
    const hooked = manifestFor({ name: "hooked", fill: "6", touchedComponents: ["hooks/pre.sh"] });
    writeBytes("hooked.json", hooked.bytes);

    const refused = runCli(adoptArgs("hooked.json", "--approve-payload-class=prompt"), context);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("adoption-gate");
    expect(refused.stderr).toContain("hook");

    const admitted = runCli(adoptArgs("hooked.json", "--approve-payload-class=hook"), context);
    expect(admitted.exitCode).toBe(0);
    expect(admitted.stdout).toContain("approved     hook");
  });

  it("refuses a payload class that is not on the §7.4 gradient", () => {
    preparedCampaign();
    write("tuple.json", { ...tupleFor("adopted", "5") });
    const result = runCli(adoptArgs("tuple.json", "--approve-payload-class=whatever"), context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("adoption-gate");
  });

  it("round-trips adopt -> adopt -> rollback and keeps the whole history", () => {
    preparedCampaign();
    write("first.json", { ...tupleFor("first", "5") });
    write("second.json", { ...tupleFor("second", "6") });
    expect(runCli(adoptArgs("first.json"), context).exitCode).toBe(0);
    const second = runCli(adoptArgs("second.json"), context);
    const firstDigest = prefixedDigest(canonicalTupleBytes(tupleFor("first", "5")));
    const secondDigest = prefixedDigest(canonicalTupleBytes(tupleFor("second", "6")));
    expect(second.stdout).toContain(`displaced    ${firstDigest}`);

    const undone = runCli([
      "optimize", "policy", "rollback", "--dir", "campaign", "--task-profile", PROFILE,
    ], context);
    expect(undone.exitCode).toBe(0);
    expect(undone.stdout).toContain(`restored     ${firstDigest}`);
    expect(undone.stdout).toContain(`rolled back  ${secondDigest}`);
    expect(undone.stdout).toContain("No config fragment");

    const log = JSON.parse(readFileSync(join(root, "campaign", "archive", "adoption.json"), "utf8"));
    expect(log.records.map((record: { tupleDigest: string }) => record.tupleDigest))
      .toEqual([firstDigest, secondDigest, firstDigest]);
  });

  it("prints the restored pinning when the tuple document is supplied", () => {
    preparedCampaign();
    write("first.json", { ...tupleFor("first", "5") });
    write("second.json", { ...tupleFor("second", "6") });
    runCli(adoptArgs("first.json"), context);
    runCli(adoptArgs("second.json"), context);
    const undone = runCli([
      "optimize", "policy", "rollback", "--dir", "campaign",
      "--task-profile", PROFILE, "--tuple", "first.json",
    ], context);
    expect(undone.stdout).toContain("Pin this in your operator config");
    expect(undone.stdout).toContain("\"loadout\"");
  });

  it("refuses a --tuple that does not digest to the restored policy", () => {
    preparedCampaign();
    write("first.json", { ...tupleFor("first", "5") });
    write("second.json", { ...tupleFor("second", "6") });
    runCli(adoptArgs("first.json"), context);
    runCli(adoptArgs("second.json"), context);
    const result = runCli([
      "optimize", "policy", "rollback", "--dir", "campaign",
      "--task-profile", PROFILE, "--tuple", "second.json",
    ], context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("adoption-gate");
  });

  it("refuses a rollback with nothing adopted", () => {
    preparedCampaign();
    const result = runCli([
      "optimize", "policy", "rollback", "--dir", "campaign", "--task-profile", PROFILE,
    ], context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("adoption-gate");
  });

  it("keeps routes independent", () => {
    preparedCampaign();
    write("first.json", { ...tupleFor("first", "5") });
    write("second.json", { ...tupleFor("second", "6") });
    runCli(adoptArgs("first.json"), context);
    const routed = runCli(adoptArgs("second.json", "--route", "nightly"), context);
    expect(routed.stdout).toContain("displaced    nothing");
    expect(routed.stdout).toContain(`profile      ${PROFILE} (nightly)`);
  });

  it("uses an explicit --archive-dir when one is given", () => {
    write("tuple.json", { ...tupleFor("adopted", "5") });
    const result = runCli([
      "optimize", "policy", "adopt", "--archive-dir", "elsewhere",
      "--candidate", "tuple.json", "--task-profile", PROFILE,
    ], context);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "elsewhere", "adoption.json"), "utf8")).toContain("nonDerivable");
  });
});

describe("the verb tree", () => {
  it("prints usage with no arguments and exits 0", () => {
    const result = runCli([], context);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("optimize campaign create");
    expect(result.stdout).toContain("optimize policy rollback");
  });

  it("refuses an unknown command with usage on stderr", () => {
    const result = runCli(["optimize", "campaign", "destroy"], context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown command "optimize campaign destroy"');
  });

  it("refuses an unknown flag rather than ignoring it", () => {
    const result = runCli(["optimize", "campaign", "status", "--directory", "campaign"], context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown flag --directory");
  });

  it("refuses a repeated single-valued flag", () => {
    const result = runCli([
      "optimize", "campaign", "status", "--dir", "a", "--dir", "b",
    ], context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("more than once");
  });

  it("accepts --flag=value and --flag value alike", () => {
    createThroughCli();
    expect(runCli(["optimize", "campaign", "status", "--dir=campaign"], context).exitCode).toBe(0);
    expect(runCli(["optimize", "campaign", "status", "--dir", "campaign"], context).exitCode).toBe(0);
  });

  it("never throws — every refusal comes back as a result", () => {
    expect(() => runCli(["optimize", "campaign", "status"], context)).not.toThrow();
    expect(runCli(["optimize", "campaign", "status"], context).exitCode).toBe(1);
  });
});
