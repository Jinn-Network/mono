// SPDX-License-Identifier: MIT

/**
 * `optimize policy adopt | rollback` — the §9 verbs, over the §7.4 gate.
 *
 * **Non-interactive by construction.** §7.4's gate is a consent decision, and a consent decision
 * taken by pressing return on a prompt in a script is not one. Every payload class is approved by
 * name on the command line (`--approve-payload-class=hook`), so the consent is in the operator's
 * shell history, in the record, and in whatever ran the command.
 *
 * **Nothing here touches a daemon.** Adoption is recorded; the config fragment that pins the tuple
 * for a task route is *printed*, for the operator to install. §9 makes adoption an operator-local
 * decision with product support, and editing a running daemon's config would be this product
 * making a deployment decision it was never asked to make. The freeze-fence and L1 revert remain
 * the safety net under any adopted policy — this verb does not replace them and does not claim to.
 */

import {
  canonicalTupleBytes,
  parseExactCandidateManifest,
  prefixedDigest,
  type ExecutionPolicyTuple,
} from "@jinn-network/policy-identity";
import { refuse } from "../errors.js";
import {
  adopt,
  adoptionConfigFragment,
  currentAdoption,
  declaredAdoptionComponentClasses,
  formatAdoptionComponentClasses,
  isAdoptionComponentClass,
  rollback,
} from "../archive/adoption.js";
import { appendAdoptionRecord, archiveLayout, defaultArchiveRoot, readAdoptionLog } from "../archive/store.js";
import type { AdoptionRecord, AdoptionScope, AdoptionComponentClass } from "../archive/types.js";
import {
  assertKnownFlags, many, optional, pathFrom, readBytes, required, type ParsedArgs,
} from "./args.js";
import { type CliContext, type CliResult, lines, ok } from "./result.js";

const SHARED_FLAGS = ["dir", "archive-dir", "task-profile", "route", "at"] as const;

function layoutFor(args: ParsedArgs, context: CliContext) {
  const explicit = optional(args, "archive-dir");
  if (explicit !== undefined && explicit !== "") return archiveLayout(pathFrom(context.cwd, explicit));
  return archiveLayout(defaultArchiveRoot(pathFrom(context.cwd, required(args, "dir"))));
}

function scopeFrom(args: ParsedArgs): AdoptionScope {
  const route = optional(args, "route");
  return {
    taskProfile: required(args, "task-profile"),
    ...(route === undefined || route === "" ? {} : { route }),
  };
}

function approvedClasses(args: ParsedArgs): readonly AdoptionComponentClass[] {
  return many(args, "approve-payload-class").map((value) => {
    if (!isAdoptionComponentClass(value)) {
      refuse("adoption-gate", "--approve-payload-class",
        `${value === "" ? "(empty)" : value} is not a payload class; §7.4's gradient is prompt, skill, tool-config, hook, harness-fork, unclassified`);
    }
    return value;
  });
}

/**
 * Reads the tuple being adopted, from a candidate manifest or from a bare tuple document.
 *
 * Both spellings are legal targets: §7.3 keys the population by `tupleDigest`, so adopting "the
 * policy" means adopting a tuple, and a seed tuple with no manifest behind it is as adoptable as a
 * candidate. Only the manifest form carries `declaredChanges`, so only it implies payload classes.
 */
function readTarget(path: string): {
  readonly tuple: ExecutionPolicyTuple;
  readonly digest: string;
  readonly requires: readonly AdoptionComponentClass[];
} {
  const bytes = readBytes(path);
  const document = JSON.parse(new TextDecoder().decode(bytes)) as { policy?: unknown };
  if (document.policy !== undefined) {
    const manifest = parseExactCandidateManifest(bytes);
    return {
      tuple: manifest.policy,
      digest: prefixedDigest(canonicalTupleBytes(manifest.policy)),
      requires: declaredAdoptionComponentClasses(manifest),
    };
  }
  const tuple = document as unknown as ExecutionPolicyTuple;
  return { tuple, digest: prefixedDigest(canonicalTupleBytes(tuple)), requires: [] };
}

function fragmentBlock(record: AdoptionRecord, tuple: ExecutionPolicyTuple): readonly string[] {
  return [
    "",
    "Pin this in your operator config (nothing was changed for you):",
    JSON.stringify(adoptionConfigFragment(record, tuple), null, 2),
  ];
}

export function policyAdopt(args: ParsedArgs, context: CliContext): CliResult {
  assertKnownFlags(args, [...SHARED_FLAGS, "candidate", "approve-payload-class"]);
  const layout = layoutFor(args, context);
  const target = readTarget(pathFrom(context.cwd, required(args, "candidate")));
  const at = optional(args, "at") ?? context.now();

  const record = adopt({
    log: readAdoptionLog(layout),
    scope: scopeFrom(args),
    tupleDigest: target.digest,
    requires: target.requires,
    approved: approvedClasses(args),
    adoptedAt: at,
  });
  appendAdoptionRecord(layout, record);

  return ok(lines(
    `adopted      ${record.tupleDigest}`,
    `profile      ${record.scope.taskProfile}${record.scope.route === undefined ? "" : ` (${record.scope.route})`}`,
    `displaced    ${record.priorTuple ?? "nothing — this scope had no adoption"}`,
    `approved     ${formatAdoptionComponentClasses(record.payloadClassesApproved)}`,
    `recorded     ${layout.adoptionPath} (not re-derivable — keep it)`,
    ...fragmentBlock(record, target.tuple),
  ));
}

export function policyRollback(args: ParsedArgs, context: CliContext): CliResult {
  assertKnownFlags(args, [...SHARED_FLAGS, "tuple"]);
  const layout = layoutFor(args, context);
  const scope = scopeFrom(args);
  const displaced = currentAdoption(readAdoptionLog(layout), scope);
  const record = rollback(readAdoptionLog(layout), scope, optional(args, "at") ?? context.now());
  appendAdoptionRecord(layout, record);

  const head = [
    `restored     ${record.tupleDigest}`,
    `profile      ${record.scope.taskProfile}${record.scope.route === undefined ? "" : ` (${record.scope.route})`}`,
    `rolled back  ${displaced?.tupleDigest ?? record.priorTuple}`,
    `approved     ${formatAdoptionComponentClasses(record.payloadClassesApproved)}`,
    `recorded     ${layout.adoptionPath} (append-only — the rollback is itself a decision)`,
  ];

  // The log stores digests, not tuples, so the fragment needs the restored tuple's bytes. Saying so
  // is better than emitting a fragment with a hole in it, or than storing a second copy of a tuple
  // the operator already has.
  const tuplePath = optional(args, "tuple");
  if (tuplePath === undefined || tuplePath === "") {
    return ok(lines(...head, "",
      `No config fragment: the log holds digests, not tuples. Re-run with --tuple <file> naming the`,
      `document that digests to ${record.tupleDigest} to have the pinning printed.`));
  }
  const target = readTarget(pathFrom(context.cwd, tuplePath));
  if (target.digest !== record.tupleDigest) {
    refuse("adoption-gate", "--tuple",
      `--tuple digests to ${target.digest}; the restored policy is ${record.tupleDigest}`);
  }
  return ok(lines(...head, ...fragmentBlock(record, target.tuple)));
}
