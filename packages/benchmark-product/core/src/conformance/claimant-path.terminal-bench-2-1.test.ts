// SPDX-License-Identifier: Apache-2.0

/**
 * The claimant path on the official Terminal-Bench 2.1 slate, driven end to end through the CLI
 * (#4937), from an empty directory to an anchored bundle a reader has checked (#4936, #4938).
 *
 * Every step of this path had a test, and each used its own stand-in: the catalog method was
 * tested up to the lock, the Harbor reader against a hand-built name table, and import against the
 * bundled sample tasks. The slate `method terminal-bench-2.1` binds and the jobs directory a real
 * Harbor 0.21 run writes never met in one test, so the reader refused every draft the method
 * produced and nothing caught it. Nor did any test publish a bundle that was both imported and
 * anchored, which is the bundle this path ends in.
 *
 * This test is that meeting. It types the commands a claimant types, in order, against a temp
 * workspace and the real Harbor 0.21.0 jobs directory under
 * `test/fixtures/harbor-0.21-jobs-terminal-bench-2-1/`. Then it does what a reader does: it copies
 * the bundle directory out, deletes the workspace, and runs the standalone checker on the copy,
 * once with no trust material and once with the timestamp authority's root.
 *
 * It is hermetic: no network, no Docker, no model, and no venue beyond what `quote` reads from the
 * local machine. The one outside party, the timestamp authority, is the trust kit's fixture
 * authority, injected where the CLI would otherwise make its single request.
 *
 * To extend the path, append to `CLAIMANT_STEPS`: each step is one CLI invocation at a fixed
 * instant, and `beforeAll` runs the list once, stopping at the first step that does not end the
 * way it declares.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RFC3161_TSA_ANCHOR_PROFILE } from "@jinn-network/trust-core";
import { KIT_AUTHORITY_SEED, createFixtureAuthority } from "@jinn-network/trust-testing";
import {
  BUNDLE_V10_FORMAT,
  IMPORTED_RUN_PINNING_LIMIT,
  TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
  runVerifierCli,
  verifyPublicBundle,
  type VerifierCliResult,
} from "@colophon-claims/check";
import { CLAIMANT_COMMAND_PATH } from "../cli/claimant-path.js";
import { runCli } from "../cli/main.js";
import type { CliContext, CliResult } from "../cli/result.js";
import { readDraftDocument } from "../operations/drafts.js";
import { ExternalRunImportDeclarationSchema, type ExternalRunImportDeclaration } from "../run/external-import.js";
import { readRunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";

const HARBOR_JOBS = fileURLToPath(
  new URL("../../test/fixtures/harbor-0.21-jobs-terminal-bench-2-1/jobs", import.meta.url),
);

const PRINCIPAL = "claimant";
const DRAFT = "draft-1";
/** The three official tasks the fixture holds trials for. */
const TASKS = ["adaptive-rejection-sampler", "cancel-async-tasks", "chess-best-move"] as const;
/** The two Harbor jobs in the fixture, as the arms a claimant declares for them. */
const TERMINUS_PINNING = {
  agent: { id: "terminus-2", version: "2.0.0" },
  model: { id: "openrouter/deepseek/deepseek-v4.1-flash" },
};
const ORACLE_PINNING = { agent: { id: "oracle", version: "1.0.0" } };
const ARMS = ["oracle", "terminus-2"] as const;

/** The lock must precede the fixture's earliest trial start (12:58:28Z) ... */
const BEFORE_THE_RUN = "2026-10-01T12:00:00.000Z";
/** ... the anchor comes after the lock and still before that first trial ... */
const AT_THE_ANCHOR = "2026-10-01T12:30:00.000Z";
/** ... and the import must follow its latest trial finish (13:39:36Z). */
const AFTER_THE_RUN = "2026-10-01T14:00:00.000Z";

/**
 * The timestamp authority. It is the trust kit's seeded fixture authority, standing in for the
 * service a claimant names with `--endpoint`: it signs a real RFC 3161 token over the digest it is
 * asked about, and its own certificate is the root a reader is handed. The kit never reads the
 * wall clock, so the token is minted at the instant the `anchor` command runs at.
 */
const authority = createFixtureAuthority(KIT_AUTHORITY_SEED);
/** `AT_THE_ANCHOR` as the DER GeneralizedTime a token carries, and as a reader sees it printed. */
const ANCHOR_GEN_TIME_DER = "20261001123000Z";
const ANCHOR_GEN_TIME = "2026-10-01T12:30:00Z";
/** No request leaves this process: the source below is injected, and `.invalid` never resolves. */
const TSA_ENDPOINT = "http://timestamp.invalid";

const anchorDeps: NonNullable<CliContext["anchorDeps"]> = {
  sources: {
    [RFC3161_TSA_ANCHOR_PROFILE]: {
      profile: RFC3161_TSA_ANCHOR_PROFILE,
      async obtainProof(request) {
        return authority.mintTimeStampToken({
          subjectSha256: request.subjectSha256,
          genTime: ANCHOR_GEN_TIME_DER,
        }).tokenDer;
      },
    },
  },
};

interface ClaimantPaths {
  readonly workspaceDir: string;
  /** The generic dump a claimant might write by hand; see the `run import --file` step. */
  readonly dumpPath: string;
}

interface ClaimantStep {
  readonly name: string;
  /** The instant the command runs at. */
  readonly at: string;
  readonly argv: (paths: ClaimantPaths) => readonly string[];
  /** Run without `--json`, so stdout is the text a claimant reads. */
  readonly human?: true;
  /** A command the product must refuse. The path carries on after it, with nothing written. */
  readonly refused?: true;
}

function onDraft(paths: ClaimantPaths): readonly string[] {
  return ["--workspace", paths.workspaceDir, "--principal", PRINCIPAL, "--draft", DRAFT];
}

let root: string;
let paths: ClaimantPaths;
const ran = new Map<string, CliResult>();
/** The draft's lifecycle state after each step that ended the way it declares. */
const stateAfter = new Map<string, string>();
/** The instant the Run was sealed, read from the workspace once it holds one. */
let lockedAt: string | undefined;

/**
 * Writes the dump: the skeleton `run import --template` printed, with every slot marked `unrun`.
 * It names each sealed slot exactly once, so nothing about the dump itself is refusable.
 */
function writeGenericDump(target: ClaimantPaths): string {
  const template = ran.get("run import --template")!.stdout;
  const rows = template.trimEnd().split("\n").map((line) => {
    const row = JSON.parse(line) as { readonly cellKey: string };
    return JSON.stringify({ cellKey: row.cellKey, outcome: "unrun", reason: "written by hand, not read from Harbor" });
  });
  writeFileSync(target.dumpPath, `${rows.join("\n")}\n`);
  return target.dumpPath;
}

/** The claimant's commands, in the order they are typed. */
const CLAIMANT_STEPS: readonly ClaimantStep[] = [
  {
    name: "init",
    at: BEFORE_THE_RUN,
    argv: (paths) => ["init", "--workspace", paths.workspaceDir, "--principal", PRINCIPAL],
  },
  {
    name: "draft create",
    at: BEFORE_THE_RUN,
    argv: (paths) => [
      "draft", "create", "--workspace", paths.workspaceDir, "--principal", PRINCIPAL,
      "--name", "Terminal-Bench 2.1, brought from Harbor", "--id", DRAFT,
    ],
  },
  {
    name: "method terminal-bench-2.1",
    at: BEFORE_THE_RUN,
    argv: (paths) => ["method", "terminal-bench-2.1", ...onDraft(paths), "--ids", TASKS.join(",")],
  },
  {
    name: "arm add terminus-2",
    at: BEFORE_THE_RUN,
    argv: (paths) => [
      "arm", "add", ...onDraft(paths), "--arm", "terminus-2", "--pinning", JSON.stringify(TERMINUS_PINNING),
    ],
  },
  {
    name: "arm add oracle",
    at: BEFORE_THE_RUN,
    argv: (paths) => ["arm", "add", ...onDraft(paths), "--arm", "oracle", "--pinning", JSON.stringify(ORACLE_PINNING)],
  },
  { name: "quote", at: BEFORE_THE_RUN, argv: (paths) => ["quote", ...onDraft(paths)] },
  {
    // Read as text: the Run digest this line prints is the one a reader later holds the checker's
    // own `Run:` line against.
    name: "lock",
    at: BEFORE_THE_RUN,
    human: true,
    argv: (paths) => ["lock", ...onDraft(paths), "--ack-sample-size"],
  },
  {
    // Before Harbor starts: `run import` marks the run as started, and a lock anchor is refused
    // from then on.
    name: "anchor --subject lock",
    at: AT_THE_ANCHOR,
    argv: (paths) => [
      "anchor", ...onDraft(paths), "--subject", "lock",
      "--provider", RFC3161_TSA_ANCHOR_PROFILE, "--endpoint", TSA_ENDPOINT,
    ],
  },
  // A detour this slate does not allow: the generic dump. These two commands are what a claimant
  // who wrote the records by hand would type, and the second is refused.
  {
    name: "run import --template",
    at: AFTER_THE_RUN,
    human: true,
    argv: (paths) => ["run", "import", "--template", ...onDraft(paths)],
  },
  {
    name: "run import --file",
    at: AFTER_THE_RUN,
    refused: true,
    argv: (paths) => ["run", "import", "--file", writeGenericDump(paths), "--source", "harbor", ...onDraft(paths)],
  },
  {
    name: "run import --from harbor",
    at: AFTER_THE_RUN,
    argv: (paths) => ["run", "import", "--from", "harbor", HARBOR_JOBS, ...onDraft(paths)],
  },
  { name: "collect", at: "2026-10-01T14:05:00.000Z", argv: (paths) => ["collect", ...onDraft(paths)] },
  { name: "report", at: "2026-10-01T14:10:00.000Z", argv: (paths) => ["report", ...onDraft(paths)] },
  { name: "publish", at: "2026-10-01T14:15:00.000Z", argv: (paths) => ["publish", ...onDraft(paths)] },
];

/** What is read out of the workspace before it is deleted. */
interface WorkspaceFacts {
  readonly declaration: ExternalRunImportDeclaration;
  /** Sealed Task digest to the official task name its payload seals. */
  readonly taskNames: ReadonlyMap<string, string>;
}

/** What a reader has: the copied bundle directory, and what the checker says about it. */
interface ReaderView {
  readonly bundleDir: string;
  readonly bare: Awaited<ReturnType<typeof verifyPublicBundle>>;
  readonly withRoot: Awaited<ReturnType<typeof verifyPublicBundle>>;
  readonly cliBare: VerifierCliResult;
  readonly cliWithRoot: VerifierCliResult;
}

let workspaceFacts: WorkspaceFacts | undefined;
let readerView: ReaderView | undefined;

/** A clock that starts at `at` and never repeats or runs backwards within one command. */
function clockAt(at: string): () => string {
  let ms = Date.parse(at);
  return () => {
    const value = new Date(ms).toISOString();
    ms += 10;
    return value;
  };
}

function outputOf(step: string): CliResult {
  const result = ran.get(step);
  if (result === undefined) throw new Error(`the claimant path never reached "${step}"`);
  return result;
}

function resultOf(step: string): Record<string, any> {
  const result = outputOf(step);
  const envelope = JSON.parse(result.stdout) as { ok: boolean; result?: Record<string, any> };
  if (!envelope.ok || envelope.result === undefined) throw new Error(`"${step}" did not succeed: ${result.stdout}`);
  return envelope.result;
}

function facts(): WorkspaceFacts {
  if (workspaceFacts === undefined) throw new Error("the claimant path never reached a published bundle");
  return workspaceFacts;
}

function reader(): ReaderView {
  if (readerView === undefined) throw new Error("the claimant path never reached a published bundle");
  return readerView;
}

function bundleJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(join(reader().bundleDir, path), "utf8")) as Record<string, any>;
}

/** The one line of a text report that starts with `label`, without the label. */
function lineAfter(text: string, label: string): string {
  const lines = text.split("\n").filter((line) => line.startsWith(label));
  expect(lines, `exactly one line starting "${label}"`).toHaveLength(1);
  return lines[0]!.slice(label.length);
}

/** The Run digest exactly as `lock` printed it. */
function lockedRun(): string {
  return lineAfter(outputOf("lock").stdout, `locked draft ${DRAFT}: run `).split(", closes ")[0]!;
}

/** Every trial directory of the fixture, with the Harbor job it sits under, which is its arm. */
function fixtureTrials(): readonly { readonly arm: string; readonly dir: string }[] {
  return readdirSync(HARBOR_JOBS).flatMap((arm) =>
    readdirSync(join(HARBOR_JOBS, arm), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((trial) => ({ arm, dir: join(HARBOR_JOBS, arm, trial.name) })));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bp-claimant-path-tb21-"));
  paths = { workspaceDir: join(root, "ws"), dumpPath: join(root, "records.jsonl") };
  for (const step of CLAIMANT_STEPS) {
    const context: CliContext = { cwd: root, clock: clockAt(step.at), anchorDeps };
    const result = await runCli([...step.argv(paths), ...(step.human === true ? [] : ["--json"])], context);
    ran.set(step.name, result);
    if ((result.exitCode === 0) === (step.refused === true)) return;
    if (step.name === "init") continue;
    stateAfter.set(step.name, readDraftDocument(paths.workspaceDir, DRAFT).state);
    lockedAt ??= readRunState(paths.workspaceDir, DRAFT)?.lockedAt;
  }

  const sealedJson = (sha256: string): unknown =>
    JSON.parse(new TextDecoder().decode(getSealedBytes(paths.workspaceDir, sha256)));
  const declaration = ExternalRunImportDeclarationSchema.parse(
    sealedJson(resultOf("run import --from harbor")["declarationSha256"] as string),
  );
  workspaceFacts = {
    declaration,
    taskNames: new Map([...new Set(declaration.rows.map((row) => row.cellKey.split("/")[0]!))].map((taskSha256) => [
      taskSha256,
      (sealedJson(taskSha256) as { readonly payload: { readonly taskName: string } }).payload.taskName,
    ])),
  };

  // From here on the test is the reader. The bundle directory is copied out, and the workspace
  // that made it is deleted before a single byte is checked.
  const bundleDir = join(root, "bundle");
  cpSync(join(paths.workspaceDir, resultOf("publish")["bundleRelativePath"] as string), bundleDir, { recursive: true });
  rmSync(paths.workspaceDir, { recursive: true, force: true });
  const rootPath = join(root, "timestamp-authority-root.der");
  writeFileSync(rootPath, authority.certificateDer);
  readerView = {
    bundleDir,
    bare: await verifyPublicBundle(bundleDir),
    withRoot: await verifyPublicBundle(bundleDir, {
      anchorTrust: { rfc3161: { trustAnchorsDer: [authority.certificateDer] } },
    }),
    cliBare: await runVerifierCli([bundleDir]),
    cliWithRoot: await runVerifierCli([bundleDir, "--tsa-root", rootPath]),
  };
}, 300_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("claimant path: method terminal-bench-2.1 to a published bundle of an anchored Harbor 0.21 run", () => {
  test.each(CLAIMANT_STEPS.filter((step) => step.refused !== true).map((step) => step.name))("%s exits 0", (name) => {
    const result = ran.get(name);
    expect(result, `the path stopped before "${name}"`).toBeDefined();
    expect(result!.exitCode, result!.stdout + result!.stderr).toBe(0);
  });

  test("the steps are the published claimant command path, every command of it and in its order", () => {
    // `CLAIMANT_COMMAND_PATH` is the list the CLI help prints. A command added to it has to be
    // walked here, and this walk takes no command it does not name.
    const verbs = CLAIMANT_STEPS.map((step) =>
      CLAIMANT_COMMAND_PATH.find(({ verb }) => step.name === verb || step.name.startsWith(`${verb} `))?.verb ?? step.name);
    expect(verbs.filter((verb, index) => verb !== verbs[index - 1])).toEqual(CLAIMANT_COMMAND_PATH.map(({ verb }) => verb));
  });

  test("the draft takes each state in turn, and the refused dump moves nothing", () => {
    expect(Object.fromEntries(stateAfter)).toEqual({
      "draft create": "draft",
      "method terminal-bench-2.1": "draft",
      "arm add terminus-2": "draft",
      "arm add oracle": "draft",
      quote: "quoted",
      lock: "locked",
      "anchor --subject lock": "locked",
      "run import --template": "locked",
      "run import --file": "locked",
      "run import --from harbor": "running",
      collect: "closed",
      report: "reported",
      publish: "published-bundle",
    });
  });

  test("the catalog method binds the official slate and the lock seals a Run on it", () => {
    expect(resultOf("method terminal-bench-2.1")).toMatchObject({ catalogId: "terminal-bench-2.1", official: true });
    expect(lockedRun()).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("the lock is anchored after it is sealed and before the first Harbor trial starts", () => {
    expect(resultOf("anchor --subject lock")).toMatchObject({
      subject: "lock",
      provider: RFC3161_TSA_ANCHOR_PROFILE,
      subjectSha256: lockedRun(),
      // The claimant's machine holds no trust material, so it can say the token is well formed
      // and covers this Run, and no more. Whether its time is believed is the reader's call.
      proofStatus: "present",
    });
    const trialStarts = fixtureTrials().map((trial) => Date.parse(
      (JSON.parse(readFileSync(join(trial.dir, "result.json"), "utf8")) as { readonly started_at: string }).started_at,
    ));
    expect(trialStarts).toHaveLength(6);
    const anchoredAt = Date.parse(ANCHOR_GEN_TIME);
    expect(lockedAt, "the workspace holds a sealed Run").toBeDefined();
    expect(Date.parse(lockedAt!)).toBeLessThan(anchoredAt);
    expect(anchoredAt).toBeLessThan(Math.min(...trialStarts));
  });

  test("a --file dump is refused on this slate, and the refusal names the Harbor reader", () => {
    const refused = outputOf("run import --file");
    expect(refused.exitCode).not.toBe(0);
    const envelope = JSON.parse(refused.stdout) as { ok: boolean; error?: { code: string; detail: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("conflict");
    expect(envelope.error?.detail).toContain("official Terminal-Bench 2.1 slate");
    expect(envelope.error?.detail).toContain("`run import --from harbor <jobs-dir>`");
    // The dump itself was sound: it named all six sealed slots, once each.
    expect(readFileSync(paths.dumpPath, "utf8").trimEnd().split("\n")).toHaveLength(6);
  });

  test("the Harbor jobs directory imports onto the locked slate, every cell graded", () => {
    expect(resultOf("run import --from harbor")).toMatchObject({
      importedCellCount: 6,
      written: { graded: 6, ungradeable: 0, notDelivered: 0 },
    });
    expect(stateAfter.get("run import --from harbor")).toBe("running");
  });

  test("each imported cell is graded from its Harbor trial's raw reward", () => {
    const { declaration, taskNames } = facts();
    expect(declaration.source).toEqual({ harness: "harbor", version: "0.21.0" });
    const classified = Object.fromEntries(declaration.rows.map((row) => {
      const [taskSha256, armId] = row.cellKey.split("/") as [string, string];
      return [`${armId}: ${taskNames.get(taskSha256)}`, row.reason === undefined ? row.outcome : `${row.outcome} (${row.reason})`];
    }));
    // Each official Task seals an EvaluationSpec that declares Harbor's `reward`, so a finished
    // trial whose result carries that reward is graded by it. That includes the terminus-2 trial
    // of chess-best-move, which ran to `AgentTimeoutError` and still has a reward of 0.
    expect(classified).toEqual({
      "oracle: adaptive-rejection-sampler": "graded",
      "oracle: cancel-async-tasks": "graded",
      "oracle: chess-best-move": "graded",
      "terminus-2: adaptive-rejection-sampler": "graded",
      "terminus-2: cancel-async-tasks": "graded",
      "terminus-2: chess-best-move": "graded",
    });
    const evidenced = declaration.rows.filter((row) => row.evidence !== undefined);
    expect(evidenced).toHaveLength(6);
    for (const row of evidenced) {
      expect(row.evidence!.map((file) => file.name)).toEqual(["trial-result.json", "trial-config.json", "reward.txt"]);
    }
  });
});

describe("reader path: the copied bundle, checked with the workspace gone", () => {
  test("the bundle declares the four capabilities of an anchored Harbor run on the official slate", () => {
    const { bare } = reader();
    if (bare.format !== BUNDLE_V10_FORMAT) throw new Error(`expected ${BUNDLE_V10_FORMAT}, got ${bare.format}`);
    expect(bare.capabilities).toEqual([
      "anchoring",
      "external-import",
      "owner-controlled-publication",
      "terminal-bench-2-1-comparability",
    ]);
    expect(bundleJson("bundle.json")["capabilities"]).toEqual(bare.capabilities);
    expect(resultOf("publish")["bundleIdentity"]).toBe(bare.identity);
    expect(bare.checks).toEqual([
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
      "integrity-anchors",
      "external-import",
    ]);
  });

  test("each arm's judged count and rate are the ones its Harbor reward files give", () => {
    // Counted here from the fixture, not copied from the bundle. A trial is judged when Harbor's
    // verifier wrote it a reward, a reward of 1 is a pass, and the rate is passes over judged
    // trials, to four places.
    const expected = Object.fromEntries(ARMS.map((arm) => {
      const rewards = fixtureTrials()
        .filter((trial) => trial.arm === arm)
        .map((trial) => join(trial.dir, "verifier", "reward.txt"))
        .filter((rewardFile) => existsSync(rewardFile))
        .map((rewardFile) => Number(readFileSync(rewardFile, "utf8")));
      const passes = rewards.filter((reward) => reward === 1).length;
      return [arm, { n: rewards.length, passRate: (passes / rewards.length).toFixed(4) }];
    }));
    expect(expected).toEqual({
      oracle: { n: 3, passRate: "1.0000" },
      "terminus-2": { n: 3, passRate: "0.3333" },
    });
    const claim = bundleJson("claim-package.json");
    const headline = claim["headline"] as Record<string, unknown>;
    expect(Object.keys(headline).sort()).toEqual([...ARMS]);
    for (const arm of ARMS) expect(headline[arm]).toMatchObject(expected[arm]!);
    expect(claim["completeness"]).toMatchObject({
      expected: 6,
      judged: expected["oracle"]!.n + expected["terminus-2"]!.n,
      runOutcome: "complete",
    });
  });

  test("the claim says its measurements came from an external harness, and names it", () => {
    const claim = bundleJson("claim-package.json");
    expect(claim["externalImport"]["source"]).toEqual({ harness: "harbor", version: "0.21.0" });
    expect(claim["venueHonesty"]["limits"]).toContain(IMPORTED_RUN_PINNING_LIMIT);
  });

  test("the claim states the comparability limit, and that its pre-registration is anchored", () => {
    const claim = bundleJson("claim-package.json");
    expect(claim["terminalBench21Comparability"]).toMatchObject({
      selectedTaskCount: 3,
      datasetTaskCount: 89,
      limit: TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
    });
    expect(claim["venueHonesty"]["preRegistration"]).toBe("structural-append-order-and-anchored-time");
    expect(JSON.stringify(claim["venueHonesty"]["limits"])).toContain(
      `design digest existed no later than ${ANCHOR_GEN_TIME}`,
    );
  });

  test("with no trust material the anchor is present, and with the authority's root it is verified", () => {
    const { bare, withRoot, cliBare, cliWithRoot } = reader();
    if (bare.format !== BUNDLE_V10_FORMAT || withRoot.format !== BUNDLE_V10_FORMAT) throw new Error("unreachable");
    expect(bare.anchors?.subjects).toEqual([
      { subject: "lock", outcome: "anchored" },
      { subject: "matrix", outcome: "absent" },
    ]);
    expect(bare.anchors?.anchors).toHaveLength(1);
    expect(bare.anchors?.anchors[0]).toMatchObject({
      subject: "lock",
      timeBasis: "authority-time",
      status: "present",
      trustMaterial: "none",
    });
    expect(withRoot.anchors?.anchors[0]).toMatchObject({ status: "verified", trustMaterial: "supplied" });

    expect(cliBare.exitCode, cliBare.stdout + cliBare.stderr).toBe(0);
    expect(cliBare.stdout).toContain(`  lock anchor · authority-time · present · ${ANCHOR_GEN_TIME}\n`);
    expect(cliBare.stdout).toContain("    time basis not evaluated: no trust material supplied\n");
    expect(cliWithRoot.exitCode, cliWithRoot.stdout + cliWithRoot.stderr).toBe(0);
    expect(cliWithRoot.stdout).toContain(`  lock anchor · authority-time · verified · ${ANCHOR_GEN_TIME}\n`);
    expect(cliWithRoot.stdout).toContain("    time basis evaluated against trust material you supplied\n");
  });

  test("the Run digest the checker prints is, as a string, the one lock printed", () => {
    for (const report of [reader().cliBare, reader().cliWithRoot]) {
      expect(lineAfter(report.stdout, "Run: ")).toBe(lockedRun());
    }
  });
});
