// SPDX-License-Identifier: MIT

import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  compileLiveCampaignAuthoringDocument,
  compileLiveCampaignInputs,
  type SealedLiveCampaignInputs,
} from "../live-campaign-inputs.js";
import type { PolicyOptimizationObjectivePreset } from "../objective-presets.js";
import {
  assertKnownFlags,
  many,
  optional,
  parseArgs,
  pathFrom,
  present,
  readBytes,
  required,
} from "../cli/args.js";
import { failed, lines, ok, type CliResult } from "../cli/result.js";
import { PolicyOptimizationError } from "../errors.js";
import { sealLocalLoadoutDirectory } from "./loadout-archive.js";
import { defaultHostStateRoot, ensurePrivateDirectory, secureAtomicWrite } from "./state.js";
import { prepareSweRebenchJourney } from "./swe-rebench-journey.js";
import { runLiveSweRebenchCampaign } from "./live-swe-rebench-runner.js";

export const JINN_OPTIMIZE_USAGE = `jinn-optimize — local policy optimization host

  jinn-optimize                         Start the zero-document guide (interactive TTY only)
  jinn-optimize campaign prepare        --document <live-campaign-authoring.json>
                                        [--state-dir <dir>] --confirm
  jinn-optimize campaign prepare        --snapshot <next-run-snapshot.json>
                                        --split <split-manifest.json>
                                        --objective <more-tasks-succeed@1|same-success-lower-cost@1>
                                        --baseline-arm <id> --candidate-arm <id>
                                        [--replicates <n>] [--payload-risk <class>…]
                                        [--state-dir <dir>] --confirm
  jinn-optimize campaign run            --prepared <prepared-campaign-dir|campaign-inputs.json>
                                        [--state-dir <dir>] [--codex-auth <auth.json>]
                                        [--approve-executable-change] --confirm

Headless use never starts the guide. Supply an explicit command. Preparation seals campaign
inputs but does not mutate the daemon or apply a policy. Run dispatches the exact prepared cells,
grades them in pinned containers, and produces a local recommendation; it still never applies it.
The split manifest selects the balanced
3/3/6 default, a custom explore/confirm allocation, or the test-this-change confirmation-only
journey.
`;

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = value === undefined ? 1 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function compilePrepareArguments(argv: readonly string[], cwd: string): {
  readonly sealed: SealedLiveCampaignInputs;
  readonly stateRoot: string;
  readonly confirmed: boolean;
} {
  const args = parseArgs(argv);
  if (args.words.join(" ") !== "campaign prepare") throw new Error("not a live campaign prepare command");
  assertKnownFlags(args, [
    "document", "snapshot", "split", "objective", "baseline-arm", "candidate-arm",
    "replicates", "payload-risk", "state-dir", "confirm",
  ]);
  const document = optional(args, "document");
  const flagged = ["snapshot", "split", "objective", "baseline-arm", "candidate-arm"]
    .some((name) => optional(args, name) !== undefined);
  if (document !== undefined && flagged) throw new Error("--document cannot be combined with flagged campaign inputs");
  const sealed = document !== undefined
    ? compileLiveCampaignAuthoringDocument(readBytes(pathFrom(cwd, document)))
    : compileLiveCampaignInputs({
      snapshotBytes: readBytes(pathFrom(cwd, required(args, "snapshot"))),
      splitManifestBytes: readBytes(pathFrom(cwd, required(args, "split"))),
      objectivePreset: required(args, "objective") as PolicyOptimizationObjectivePreset,
      baselineArm: required(args, "baseline-arm"),
      candidateArm: required(args, "candidate-arm"),
      replicates: positiveInteger(optional(args, "replicates"), "--replicates"),
      candidatePayloadRisks: many(args, "payload-risk"),
    });
  return {
    sealed,
    stateRoot: defaultHostStateRoot({
      ...(optional(args, "state-dir") === undefined
        ? {}
        : { explicit: pathFrom(cwd, optional(args, "state-dir")!) }),
    }),
    confirmed: present(args, "confirm"),
  };
}

export function liveCampaignConfirmationSummary(sealed: SealedLiveCampaignInputs): string {
  const campaign = sealed.campaign;
  const route = campaign.route.route === undefined
    ? campaign.route.taskProfile
    : `${campaign.route.taskProfile} / ${campaign.route.route}`;
  const exclusions = campaign.pool.exclusions.length === 0
    ? ["  none"]
    : campaign.pool.exclusions.map((entry) => `  ${entry.id}: ${entry.reason}`);
  return lines(
    `route              ${route}`,
    `config revision    ${campaign.configRevision}`,
    `captured seed      ${campaign.seed.digest}`,
    `journey            ${campaign.journey}`,
    `allocation         ${campaign.allocationPreset}`,
    `split              ${campaign.evidenceAccess.exploration.proposerGroups.length} explore-proposal / ${campaign.evidenceAccess.exploration.selectionGroups.length} explore-selection / ${campaign.evidenceAccess.confirmationGroups.length} confirm groups`,
    `proof threshold    ${campaign.evidenceAccess.confirmationGroups.length < 6
      ? "cannot reach proven; this run can still return promising or inconclusive evidence"
      : "attainable with at least six non-tied groups; never guaranteed"}`,
    `exclusions         ${campaign.pool.exclusions.length}`,
    ...exclusions,
    `objective          ${campaign.objectivePreset}`,
    `candidate payload  ${campaign.candidatePayloadRisks.length === 0 ? "none declared" : campaign.candidatePayloadRisks.join(", ")}`,
    `execution cells    ${campaign.executionCells.selection} explore-selection + ${campaign.executionCells.confirmation} confirmation = ${campaign.executionCells.total}`,
    `limitation         ${campaign.limitations[0]}`,
    `campaign inputs    ${sealed.digest}`,
  );
}

export function persistLiveCampaignInputs(input: {
  readonly sealed: SealedLiveCampaignInputs;
  readonly stateRoot: string;
}): string {
  const root = ensurePrivateDirectory(input.stateRoot);
  const path = join(root, "prepared", input.sealed.digest.slice("sha256:".length), "campaign-inputs.json");
  secureAtomicWrite(path, input.sealed.bytes, true);
  return path;
}

function preparedRootAndState(input: {
  readonly cwd: string;
  readonly prepared: string;
  readonly stateDir?: string;
}): { readonly preparedRoot: string; readonly stateRoot: string } {
  const selected = pathFrom(input.cwd, input.prepared);
  const preparedRoot = lstatSync(selected).isDirectory() ? selected : dirname(selected);
  const inferred = basename(dirname(preparedRoot)) === "prepared"
    ? dirname(dirname(preparedRoot))
    : undefined;
  return {
    preparedRoot,
    stateRoot: input.stateDir === undefined
      ? inferred ?? defaultHostStateRoot()
      : pathFrom(input.cwd, input.stateDir),
  };
}

async function runPreparedCampaign(
  argv: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<CliResult> {
  const args = parseArgs(argv);
  assertKnownFlags(args, [
    "prepared", "state-dir", "codex-auth", "approve-executable-change", "confirm",
  ]);
  const paths = preparedRootAndState({
    cwd,
    prepared: required(args, "prepared"),
    ...(optional(args, "state-dir") === undefined ? {} : { stateDir: optional(args, "state-dir") }),
  });
  if (!present(args, "confirm")) {
    return failed(lines(
      `prepared campaign  ${paths.preparedRoot}`,
      "work              one solver call and one pinned container grade per prepared cell",
      "effect            writes evidence and a recommendation; never changes the daemon",
      "Explicit spend confirmation is required; repeat with --confirm.",
    ));
  }
  const progress: string[] = [];
  const result = await runLiveSweRebenchCampaign({
    preparedRoot: paths.preparedRoot,
    stateRoot: paths.stateRoot,
    codexAuthPath: optional(args, "codex-auth") === undefined
      ? join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json")
      : pathFrom(cwd, optional(args, "codex-auth")!),
    executableChangeConsent: present(args, "approve-executable-change"),
    ...(signal === undefined ? {} : { signal }),
    onProgress: (message) => progress.push(message),
  });
  return ok(lines(
    ...progress,
    "",
    `recommendation      ${result.status}`,
    `recommended tuple   ${result.recommendedTupleDigest}`,
    `reasons             ${result.reasonCodes.length === 0 ? "proof gates passed" : result.reasonCodes.join(", ")}`,
    `evidence            ${result.resultPath}`,
    "No daemon configuration was changed. Adoption remains a separate operator decision.",
  ));
}

export async function runLiveHostCommand(
  argv: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<CliResult | undefined> {
  if (argv[0] === "campaign" && argv[1] === "run") {
    try { return await runPreparedCampaign(argv, cwd, signal); }
    catch (cause) {
      if (cause instanceof PolicyOptimizationError) return failed(`${cause.category}: ${cause.message}`);
      return failed(cause instanceof Error ? cause.message : String(cause));
    }
  }
  if (argv[0] !== "campaign" || argv[1] !== "prepare") return undefined;
  try {
    const prepared = compilePrepareArguments(argv, cwd);
    const summary = liveCampaignConfirmationSummary(prepared.sealed);
    if (!prepared.confirmed) {
      return failed(`${summary}\nExplicit confirmation is required; repeat with --confirm.`);
    }
    const path = persistLiveCampaignInputs(prepared);
    return ok(`${summary}prepared at        ${path}\nNo daemon configuration was changed.\n`);
  } catch (cause) {
    if (cause instanceof PolicyOptimizationError) return failed(`${cause.category}: ${cause.message}`);
    return failed(cause instanceof Error ? cause.message : String(cause));
  }
}

export interface GuideIo {
  question(prompt: string): Promise<string>;
  write(text: string): void;
}

function answerOrDefault(answer: string, fallback: string): string {
  const value = answer.trim();
  return value === "" ? fallback : value;
}

async function runAdvancedDocumentJourney(input: {
  readonly cwd: string;
  readonly io: GuideIo;
}): Promise<CliResult> {
  const document = (await input.io.question("Campaign authoring document: ")).trim();
  if (document === "") return failed("a campaign authoring document is required");
  const requestedState = (await input.io.question("Private state directory (blank for XDG default): ")).trim();
  const prepared = compilePrepareArguments([
    "campaign", "prepare", "--document", document,
    ...(requestedState === "" ? [] : ["--state-dir", requestedState]),
  ], input.cwd);
  const summary = liveCampaignConfirmationSummary(prepared.sealed);
  input.io.write(`\nReview before confirmation\n${summary}`);
  const confirmation = (await input.io.question("Prepare these exact inputs? Type 'yes' to confirm: ")).trim();
  if (confirmation !== "yes") return failed("campaign preparation cancelled; nothing was written");
  const path = persistLiveCampaignInputs(prepared);
  return ok(`prepared at        ${path}\nNo daemon configuration was changed.\n`);
}

/**
 * The default journey needs no authored JSON. Advanced users can still choose the exact-document
 * path, which continues to compile through the same canonical campaign-input boundary.
 */
export async function runGuidedJourney(input: {
  readonly cwd: string;
  readonly io: GuideIo;
  readonly now?: () => Date;
  readonly prepareJourney?: typeof prepareSweRebenchJourney;
}): Promise<CliResult> {
  try {
    input.io.write(lines(
      "Jinn Policy Optimization",
      "",
      "What do you want to do?",
      "  1  Test a change against the policy you use now",
      "  2  Explore possible improvements (guided proposer — not in this first live slice)",
      "  3  Prepare an authored campaign document (advanced)",
    ));
    const goal = answerOrDefault(await input.io.question("Choose 1–3 [1]: "), "1");
    if (goal === "3") return await runAdvancedDocumentJourney(input);
    if (goal === "2") {
      return failed("guided exploration is not live yet; choose 1 to test a change with real tasks, or 3 for an authored exploration campaign");
    }
    if (goal !== "1") return failed("choose 1, 2, or 3");

    input.io.write(lines(
      "",
      "This first live journey compares two public learner loadouts on six fresh",
      "SWE-rebench task groups. It prepares exact inputs for review; it does not run",
      "the solvers, spend money, or change your daemon.",
      "",
    ));
    const routeName = answerOrDefault(await input.io.question("Route name [swe-rebench-v2]: "), "swe-rebench-v2");
    const currentPath = (await input.io.question("Current learner loadout directory: ")).trim();
    if (currentPath === "") return failed("the current learner loadout directory is required");
    const candidatePath = (await input.io.question("Changed learner loadout directory: ")).trim();
    if (candidatePath === "") return failed("the changed learner loadout directory is required");
    const harness = answerOrDefault(await input.io.question("Solver harness [codex]: "), "codex");
    const model = (await input.io.question("Model ID used by that route: ")).trim();
    if (model === "") return failed("the route's exact model ID is required");
    const isolationPolicy = answerOrDefault(
      await input.io.question("Isolation policy [unrestricted]: "),
      "unrestricted",
    );
    const requestedState = (await input.io.question("Private state directory (blank for XDG default): ")).trim();
    const stateRoot = defaultHostStateRoot({
      ...(requestedState === "" ? {} : { explicit: pathFrom(input.cwd, requestedState) }),
    });
    const currentLoadout = sealLocalLoadoutDirectory(pathFrom(input.cwd, currentPath));
    const candidateLoadout = sealLocalLoadoutDirectory(pathFrom(input.cwd, candidatePath));
    input.io.write("\nChecking the public task source and pinning grader images…\n");
    const prepared = await (input.prepareJourney ?? prepareSweRebenchJourney)({
      stateRoot,
      currentLoadout,
      candidateLoadout,
      routeName,
      harness,
      model,
      isolationPolicy,
      now: input.now ?? (() => new Date()),
    });
    const executable = prepared.candidatePayload.hostile.length === 0
      ? "no executable loadout roots detected"
      : `explicit execution consent required for ${prepared.candidatePayload.hostile.join(", ")}`;
    input.io.write(lines(
      "",
      "Review before confirmation",
      liveCampaignConfirmationSummary(prepared.campaign),
      `task source         ${prepared.source.dataset} / ${prepared.source.split}`,
      `current loadout     ${currentLoadout.treeDigest}`,
      `changed loadout     ${candidateLoadout.treeDigest}`,
      `local run plan     ${prepared.runPlan.digest}`,
      `payload consent     ${executable}`,
      "next action         prepare only; no solver dispatch and no daemon mutation",
    ));
    const confirmation = (await input.io.question("Prepare these exact inputs? Type 'yes' to confirm: ")).trim();
    if (confirmation !== "yes") return failed("campaign preparation cancelled; no campaign artifacts were written");
    const paths = prepared.persist();
    return ok(lines(
      `prepared at        ${paths.campaign}`,
      "No solver was dispatched and no daemon configuration was changed.",
      `Next: jinn-optimize campaign run --prepared ${paths.root} --confirm`,
      "That next step performs real solver calls and container grades, but still does not change the daemon.",
    ));
  } catch (cause) {
    if (cause instanceof PolicyOptimizationError) return failed(`${cause.category}: ${cause.message}`);
    return failed(cause instanceof Error ? cause.message : String(cause));
  }
}
