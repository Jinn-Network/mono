// SPDX-License-Identifier: Apache-2.0

/**
 * The verdict grades the SCRIPT, not the trajectory. Evaluation replays the submitted
 * script on a fresh instance from the same record; nothing in this package, or anywhere
 * downstream, checks that the submitted trajectory produced it. Trajectory-to-script
 * correspondence is a DECLARED trust step (design §6.4), the same posture the parent
 * takes for tier-0 source binding. A harness attestation closing it is parked (§13).
 */

import { z } from "zod";

import { canonicalJsonBytes, type CanonicalJsonValue } from "./canonical.js";
import { documentDigest, type Sha256Digest } from "./digest.js";
import { ScenarioError } from "./errors.js";
import { assertFreshFixtureAddress, normalizeAddress } from "./fixture-accounts.js";

export const CHAIN_SOLUTION_MEDIA_TYPE = "application/vnd.jinn.chain-solution.v1+json" as const;
export const CHAIN_SOLUTION_SCHEMA_VERSION =
  "https://jinn.network/records/chain-solution/1" as const;
/** F-CE5-3: §14 pins the solution media type; the reference script is its unsigned sibling. */
export const CHAIN_REFERENCE_SCRIPT_MEDIA_TYPE =
  "application/vnd.jinn.chain-reference-script.v1+json" as const;
export const CHAIN_REFERENCE_SCRIPT_SCHEMA_VERSION =
  "https://jinn.network/records/chain-reference-script/1" as const;

const NonEmpty = z.string().min(1);
const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ReportValue = z.union([z.string(), z.number().finite(), z.boolean()]);
const ValueWei = z.string().regex(/^[0-9]+$/);
const RawTransaction = z.string().regex(/^0x[0-9a-f]+$/);

const TimeWarpOperationSchema = z.strictObject({
  op: z.literal("timeWarp"),
  chainSeconds: Count,
});

const MineOperationSchema = z.strictObject({
  op: z.literal("mine"),
  blocks: Count,
});

const ReportOperationSchema = z.strictObject({
  op: z.literal("report"),
  name: NonEmpty,
  value: ReportValue,
});

const SignedTransactionOperationSchema = z.strictObject({
  op: z.literal("signedTransaction"),
  rawTransaction: RawTransaction,
});

const TransactionIntentOperationSchema = z.strictObject({
  op: z.literal("transactionIntent"),
  signerRole: NonEmpty,
  to: NonEmpty,
  abiRef: NonEmpty,
  args: z.array(z.string()),
  valueWei: ValueWei,
});

const SolutionOperationSchema = z.discriminatedUnion("op", [
  SignedTransactionOperationSchema,
  TimeWarpOperationSchema,
  MineOperationSchema,
  ReportOperationSchema,
]);

const ReferenceOperationSchema = z.discriminatedUnion("op", [
  TransactionIntentOperationSchema,
  TimeWarpOperationSchema,
  MineOperationSchema,
  ReportOperationSchema,
]);

export const ChainSolutionScriptSchema = z.strictObject({
  schemaVersion: z.literal(CHAIN_SOLUTION_SCHEMA_VERSION),
  operations: z.array(SolutionOperationSchema),
});

export const ReferenceScriptSchema = z.strictObject({
  schemaVersion: z.literal(CHAIN_REFERENCE_SCRIPT_SCHEMA_VERSION),
  operations: z.array(ReferenceOperationSchema),
});

export type ChainSolutionScript = z.infer<typeof ChainSolutionScriptSchema>;
export type ReferenceScript = z.infer<typeof ReferenceScriptSchema>;

/** The tightened subset CE5 checks before a script may be graded. */
export interface CapabilityEnvelope {
  readonly maxTransactions: number;
  readonly maxAggregateValueWei: string;
  readonly maxChainSecondsAdvanced: number;
  readonly maxBlocksMined: number;
  readonly signerRoles: readonly string[];
}

export interface SealedScriptDocument<T> {
  readonly document: T;
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
  readonly mediaType: string;
}

function parseOrThrow<T>(schema: z.ZodType<T>, document: unknown, label: string): T {
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new ScenarioError("invalid-input", `${label} failed schema validation: ${detail}`);
  }
  return parsed.data;
}

function sealDocument<T>(
  schema: z.ZodType<T>,
  document: unknown,
  label: string,
  mediaType: string,
): SealedScriptDocument<T> {
  const parsed = parseOrThrow(schema, document, label);
  const bytes = canonicalJsonBytes(parsed as CanonicalJsonValue);
  return {
    document: parsed,
    bytes,
    digest: documentDigest(bytes),
    mediaType,
  };
}

export function sealSolutionScript(script: unknown): SealedScriptDocument<ChainSolutionScript> {
  return sealDocument(
    ChainSolutionScriptSchema,
    script,
    "chain solution script",
    CHAIN_SOLUTION_MEDIA_TYPE,
  );
}

export function sealReferenceScript(script: unknown): SealedScriptDocument<ReferenceScript> {
  return sealDocument(
    ReferenceScriptSchema,
    script,
    "chain reference script",
    CHAIN_REFERENCE_SCRIPT_MEDIA_TYPE,
  );
}

export function referenceScriptDigest(script: unknown): Sha256Digest {
  return sealReferenceScript(script).digest;
}

type ScriptOperation = ChainSolutionScript["operations"][number] | ReferenceScript["operations"][number];

function isTransactionOperation(
  operation: ScriptOperation,
): operation is Extract<ScriptOperation, { op: "signedTransaction" | "transactionIntent" }> {
  return operation.op === "signedTransaction" || operation.op === "transactionIntent";
}

function isTransactionIntent(
  operation: ScriptOperation,
): operation is Extract<ScriptOperation, { op: "transactionIntent" }> {
  return operation.op === "transactionIntent";
}

/**
 * Accumulates envelope consumption across the whole script and refuses before grading when
 * any ceiling is exceeded.
 */
export function assertScriptWithinEnvelope(
  script: ChainSolutionScript | ReferenceScript,
  envelope: CapabilityEnvelope,
): void {
  let transactionCount = 0;
  let aggregateValueWei = 0n;
  let chainSecondsAdvanced = 0;
  let blocksMined = 0;
  const grantedRoles = new Set(envelope.signerRoles);

  for (const operation of script.operations) {
    if (isTransactionOperation(operation)) {
      transactionCount += 1;
    }

    if (isTransactionIntent(operation)) {
      if (!grantedRoles.has(operation.signerRole)) {
        throw new ScenarioError(
          "envelope-violation",
          `signer role "${operation.signerRole}" is not granted by the capability envelope.`,
        );
      }
      assertFreshFixtureAddress(normalizeAddress(operation.to), operation.signerRole);
      aggregateValueWei += BigInt(operation.valueWei);
    }

    if (operation.op === "timeWarp") {
      chainSecondsAdvanced += operation.chainSeconds;
    }

    if (operation.op === "mine") {
      blocksMined += operation.blocks;
    }
  }

  if (transactionCount > envelope.maxTransactions) {
    throw new ScenarioError(
      "envelope-violation",
      `transaction count ${transactionCount} exceeds maxTransactions=${envelope.maxTransactions}.`,
    );
  }

  if (aggregateValueWei > BigInt(envelope.maxAggregateValueWei)) {
    throw new ScenarioError(
      "envelope-violation",
      `aggregate native value ${aggregateValueWei.toString()} wei exceeds `
        + `maxAggregateValueWei=${envelope.maxAggregateValueWei}.`,
    );
  }

  if (chainSecondsAdvanced > envelope.maxChainSecondsAdvanced) {
    throw new ScenarioError(
      "envelope-violation",
      `time advancement ${chainSecondsAdvanced}s exceeds `
        + `maxChainSecondsAdvanced=${envelope.maxChainSecondsAdvanced}.`,
    );
  }

  if (blocksMined > envelope.maxBlocksMined) {
    throw new ScenarioError(
      "envelope-violation",
      `blocks mined ${blocksMined} exceeds maxBlocksMined=${envelope.maxBlocksMined}.`,
    );
  }
}
