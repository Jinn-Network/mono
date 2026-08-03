// SPDX-License-Identifier: MIT

// Document translation + posting (design §6.1): the requester seals Task and Submission; this
// module uploads both as raw-codec CIDs, enforces the digest-join, persists the broadcast
// intent BEFORE broadcasting (honoring the pinned 2026-07-24 crash-safety design, see
// broadcast-intent.ts), and posts one Safe-routed transaction anchoring the task digest with
// the two-rail escrow. Today-mode divergence (named): only the task digest is anchored
// on-chain; the sealed Submission's existence and terms ride in the signed announcement
// (projector, Milestone M4), verified off-chain against the digest-join.
import { encodeFunctionData, keccak256, toBytes, type Address, type Hex } from "viem";
import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import { documentDigest, sha256Hex, type SubmissionRecord } from "@jinn-network/task-execution-protocol";
import type { MarketplaceChainConfig } from "./addresses.js";
import {
  BroadcastUncertainError,
  type PostingIntent,
  type PostingIntentStore,
  type PostingOutcome,
} from "./broadcast-intent.js";
import { JINN_ROUTER_V3_ABI } from "./abis/jinn-router-v3.js";
import type { IpfsPinPort } from "./venue/ipfs.js";
import { uploadRawCodecCid } from "./venue/ipfs.js";

/**
 * The SolverNet `manifestDigest` discriminator the deployed today-mode contract still requires
 * non-zero (design §5.1: dropped in the revision; the deployed contract is unchanged, so
 * today-mode supplies a fixed marketplace-binding sentinel in its place -- nothing on-chain
 * reads it as an eligibility gate any more, per design §7 "eligibility was never
 * chain-enforced").
 */
export const MARKETPLACE_MANIFEST_DIGEST_SENTINEL: Hex = keccak256(toBytes("jinn:marketplace:binding:v1"));

/**
 * Commercial posting terms -- deliberately NOT part of the sealed Task/Submission (the sealed
 * Task forbids a `price`/`reward` field, §7.1; TEP is generic across bindings and pricing is a
 * marketplace-specific term layered on top, out-of-protocol). The caller (CLI/operator config)
 * supplies these at posting time.
 */
export interface PostingTerms {
  readonly solutionMaxDeliveryRateWei: bigint;
  readonly verdictMaxDeliveryRateWei: bigint;
  readonly responseTimeoutSeconds: bigint;
  readonly allowSolverSelfEvaluation: boolean;
}

/**
 * The chain-broadcast port: given the already-built Safe transaction params, executes it and
 * returns the confirmed `(taskId, txHash)`. Encapsulating both the Safe execution AND the
 * receipt-log decoding here keeps `postTask` itself chain-client-agnostic and unit-testable with
 * a plain stub; the production implementation composes `venue/safe.ts`'s `executeSafeTransaction`
 * with a real `viem` `PublicClient`/`WalletClient` plus `TaskCreated` log decoding (wired at
 * M2.4/M2.5).
 */
export interface SafeBroadcastPort {
  broadcastCreateTask(input: { safeAddress: Address; to: Address; value: bigint; data: Hex }): Promise<PostingOutcome>;
}

export interface PostingPorts {
  readonly ipfs: IpfsPinPort;
  readonly intents: PostingIntentStore;
  readonly safe: SafeBroadcastPort;
}

/**
 * Exact, venue-neutral description of the wallet command protected by the posting WAL. The
 * digest of these fields is the operation identity: changing a commercial term, venue, calldata
 * or value is a conflict under the same sealed Submission, never an idempotent replay.
 */
export interface PreparedPostingCommand {
  readonly venueNamespace: string;
  readonly chainId: number;
  readonly generation: MarketplaceChainConfig["generation"];
  readonly router: Address;
  readonly creatorSafe: Address;
  readonly taskCidDigest: `sha256:${string}`;
  readonly submissionDigest: `sha256:${string}`;
  readonly idempotencyKey: string;
  readonly maxClaims: number;
  readonly solutionMaxDeliveryRateWei: string;
  readonly verdictMaxDeliveryRateWei: string;
  readonly responseTimeoutSeconds: string;
  readonly allowSolverSelfEvaluation: boolean;
  readonly to: Address;
  readonly valueWei: string;
  readonly data: Hex;
  readonly commandDigest: `sha256:${string}`;
}

function decodeSubmission(submissionBytes: Uint8Array): SubmissionRecord {
  return JSON.parse(new TextDecoder().decode(submissionBytes)) as SubmissionRecord;
}

/** Builds the `JinnRouterV3.createTask` calldata (pure; exported for reuse by the real `SafeBroadcastPort` wiring). */
export function encodeCreateTaskCalldata(input: {
  taskCidDigestBytes32: Hex;
  maxClaims: number;
  allowSolverSelfEvaluation: boolean;
  solutionMaxDeliveryRateWei: bigint;
  verdictMaxDeliveryRateWei: bigint;
  responseTimeoutSeconds: bigint;
}): Hex {
  return encodeFunctionData({
    abi: JINN_ROUTER_V3_ABI,
    functionName: "createTask",
    args: [
      input.taskCidDigestBytes32,
      MARKETPLACE_MANIFEST_DIGEST_SENTINEL,
      { maxClaims: input.maxClaims, allowSolverSelfEvaluation: input.allowSolverSelfEvaluation },
      input.solutionMaxDeliveryRateWei,
      input.verdictMaxDeliveryRateWei,
      input.responseTimeoutSeconds,
    ],
  });
}

function canonicalCommandBytes(command: Omit<PreparedPostingCommand, "commandDigest">): Uint8Array {
  // All keys are deliberately written in this fixed order. BigInts are converted to decimal
  // strings before this boundary, so JSON serialization is portable and byte deterministic.
  return new TextEncoder().encode(JSON.stringify(command));
}

export function postingCommandDigestOf(
  command: Omit<PreparedPostingCommand, "commandDigest">,
): `sha256:${string}` {
  return documentDigest(canonicalCommandBytes(command));
}

/** Pure preparation shared by requester-scope claim and `postTask`; prevents command drift. */
export function preparePostingCommand(
  taskBytes: Uint8Array,
  submissionBytes: Uint8Array,
  terms: PostingTerms,
  config: MarketplaceChainConfig,
  creatorSafe: Address,
): PreparedPostingCommand {
  const taskDigestHex = sha256Hex(taskBytes);
  const taskCidDigest = documentDigest(taskBytes);
  const submission = decodeSubmission(submissionBytes);
  const boundTaskDigestHex = submission.task.digest?.["sha256"];
  if (boundTaskDigestHex !== taskDigestHex) {
    throw new TaskExecutionError("invalid-reference", {
      detail:
        `Submission's task digest (sha256:${boundTaskDigestHex ?? "none"}) does not match the `
        + `provided Task bytes' digest (${taskCidDigest}) -- refusing to prepare a mismatched pair (§6.1)`,
    });
  }

  const submissionDigest = documentDigest(submissionBytes);
  const maxClaims = submission.attempts?.maxTotal ?? 1;
  const value = (terms.solutionMaxDeliveryRateWei + terms.verdictMaxDeliveryRateWei) * BigInt(maxClaims);
  const data = encodeCreateTaskCalldata({
    taskCidDigestBytes32: `0x${taskDigestHex}` as Hex,
    maxClaims,
    allowSolverSelfEvaluation: terms.allowSolverSelfEvaluation,
    solutionMaxDeliveryRateWei: terms.solutionMaxDeliveryRateWei,
    verdictMaxDeliveryRateWei: terms.verdictMaxDeliveryRateWei,
    responseTimeoutSeconds: terms.responseTimeoutSeconds,
  });
  const withoutDigest: Omit<PreparedPostingCommand, "commandDigest"> = {
    venueNamespace: `eip155:${config.chainId}:${config.generation}:${config.jinnRouter.toLowerCase()}`,
    chainId: config.chainId,
    generation: config.generation,
    router: config.jinnRouter,
    creatorSafe,
    taskCidDigest,
    submissionDigest,
    idempotencyKey: submission.idempotencyKey,
    maxClaims,
    solutionMaxDeliveryRateWei: terms.solutionMaxDeliveryRateWei.toString(),
    verdictMaxDeliveryRateWei: terms.verdictMaxDeliveryRateWei.toString(),
    responseTimeoutSeconds: terms.responseTimeoutSeconds.toString(),
    allowSolverSelfEvaluation: terms.allowSolverSelfEvaluation,
    to: config.jinnRouter,
    valueWei: value.toString(),
    data,
  };
  return { ...withoutDigest, commandDigest: postingCommandDigestOf(withoutDigest) };
}

/**
 * Today-mode posting (design §6.1): uploads both sealed documents as raw-codec CIDs, enforces
 * the digest-join `Submission.task.digest.sha256 == sha256(taskBytes)` BEFORE broadcast,
 * persists the broadcast intent, posts one Safe-routed transaction (task-digest anchor +
 * two-rail escrow `value == (solutionRate + verdictRate) × maxClaims`), and resolves the intent
 * on success. Idempotent replay: a call whose exact `(creatorSafe, taskCidDigest,
 * submissionDigest)` key already resolved returns the prior outcome without re-broadcasting; one
 * still pending under another owner throws `BroadcastUncertainError` rather than risking a
 * double-post. The atomic owner-token claim and final pre-wallet fence are program §7.52.
 */
export async function postTask(
  taskBytes: Uint8Array,
  submissionBytes: Uint8Array,
  terms: PostingTerms,
  config: MarketplaceChainConfig,
  creatorSafe: Address,
  ports: PostingPorts,
): Promise<PostingOutcome> {
  const command = preparePostingCommand(taskBytes, submissionBytes, terms, config, creatorSafe);
  const key = {
    creatorSafe,
    taskCidDigest: command.taskCidDigest,
    submissionDigest: command.submissionDigest,
    venueNamespace: command.venueNamespace,
    commandDigest: command.commandDigest,
  };

  const intent: PostingIntent = {
    ...key,
    version: 2,
    command,
    idempotencyKey: command.idempotencyKey,
    createdAt: new Date().toISOString(),
  };
  const claim = await ports.intents.claim(intent);
  if (claim.kind === "resolved") return claim.outcome;
  if (claim.kind === "conflict") {
    throw new TaskExecutionError("submission-conflict", {
      detail: "the sealed Submission is already bound to a different marketplace posting command",
    });
  }
  if (claim.kind === "pending-other") {
    throw new BroadcastUncertainError(claim.intent);
  }

  await uploadRawCodecCid(taskBytes, ports.ipfs);
  // Today-mode divergence: the Submission is uploaded for off-chain reference by the signed
  // announcement (projector), but only the task digest is anchored on-chain (§6.1).
  await uploadRawCodecCid(submissionBytes, ports.ipfs);

  // Final owner/freshness fence immediately precedes the wallet invocation. There is no await,
  // upload, persistence call, or other external effect between a successful fence and invoking
  // `broadcastCreateTask` (program §7.52).
  if (!await ports.intents.fence(key, claim.ownerToken)) {
    throw new BroadcastUncertainError(claim.intent);
  }
  const broadcast = ports.safe.broadcastCreateTask({
    safeAddress: creatorSafe,
    to: command.to,
    value: BigInt(command.valueWei),
    data: command.data,
  });
  const outcome = await broadcast;

  await ports.intents.resolve(key, claim.ownerToken, outcome);
  return outcome;
}
