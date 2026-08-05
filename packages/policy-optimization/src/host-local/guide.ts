// SPDX-License-Identifier: MIT

import { join } from "node:path";
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
import { defaultHostStateRoot, ensurePrivateDirectory, secureAtomicWrite } from "./state.js";

export const JINN_OPTIMIZE_USAGE = `jinn-optimize — local policy optimization host

  jinn-optimize                         Start the guided journey (interactive TTY only)
  jinn-optimize campaign prepare        --document <live-campaign-authoring.json>
                                        [--state-dir <dir>] --confirm
  jinn-optimize campaign prepare        --snapshot <next-run-snapshot.json>
                                        --split <split-manifest.json>
                                        --objective <more-tasks-succeed@1|same-success-lower-cost@1>
                                        --baseline-arm <id> --candidate-arm <id>
                                        [--replicates <n>] [--payload-risk <class>…]
                                        [--state-dir <dir>] --confirm

Headless use never starts the guide. Supply an explicit command. Preparation seals campaign
inputs but does not mutate the daemon or apply a policy.
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
    `split              ${campaign.evidenceAccess.proposerGroups.length} training / ${campaign.evidenceAccess.developmentGroups.length} development / ${campaign.evidenceAccess.promotionGroups.length} promotion groups`,
    `exclusions         ${campaign.pool.exclusions.length}`,
    ...exclusions,
    `objective          ${campaign.objectivePreset}`,
    `candidate payload  ${campaign.candidatePayloadRisks.length === 0 ? "none declared" : campaign.candidatePayloadRisks.join(", ")}`,
    `execution cells    ${campaign.executionCells.development} development + ${campaign.executionCells.promotion} promotion = ${campaign.executionCells.total}`,
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

export function runLiveHostCommand(argv: readonly string[], cwd: string): CliResult | undefined {
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

/** Interactive mode uses the same authored-document compiler and persistence path as headless. */
export async function runGuidedJourney(input: {
  readonly cwd: string;
  readonly io: GuideIo;
}): Promise<CliResult> {
  try {
    input.io.write("Jinn Policy Optimization — guided local campaign\n");
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
  } catch (cause) {
    if (cause instanceof PolicyOptimizationError) return failed(`${cause.category}: ${cause.message}`);
    return failed(cause instanceof Error ? cause.message : String(cause));
  }
}
