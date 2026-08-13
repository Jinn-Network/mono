/**
 * Demo-1's benchmark-specific preregistration adapter.
 *
 * This module deliberately owns no IPFS client, wallet, RPC client, credential lookup, or
 * publication semantics. Its narrow structural port is implemented at composition time by the
 * already-existing generic IPFS/ERC-8004 manifest path: upload one exact body, anchor the returned
 * manifest CID, then read both body and chain block back. Keeping that implementation injected
 * avoids a product -> evidence-publication/layer/client import and leaves those packages' public
 * APIs unchanged.
 *
 * The returned witness is local handoff evidence, not a Tier 1-3 record and not a claim that the
 * report was published. The official lifecycle is deliberately two-step:
 *
 * 1. after lock and before any run-journal activity, verify exact read-back with
 *    `verifyDemo1PreregistrationPreDispatch`;
 * 2. once the first real official dispatch timestamp exists, verify strict external ordering with
 *    `verifyDemo1PreregistrationOrdering`.
 */

import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import { refuse, refuseWithIssues, type ProductIssue } from "../errors.js";
import type { RunJournalEntry } from "../run/journal.js";
import type { RunState } from "../run/state.js";

export const DEMO1_PREREGISTRATION_BATCH_KIND = "demo1-preregistration" as const;
export const DEMO1_PREREGISTRATION_MEDIA_TYPE =
  "application/vnd.jinn.demo1-preregistration+json" as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase sha256 hex digest");
const GitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/, "must be a full lowercase Git commit OID");
const TransactionHashSchema = z.string().regex(/^0x[a-f0-9]{64}$/, "must be a lowercase transaction hash");
const BlockHashSchema = z.string().regex(/^0x[a-f0-9]{64}$/, "must be a lowercase block hash");
const ManifestCidSchema = z.string().min(1).regex(/^\S+$/, "must be a non-empty opaque CID without whitespace");
const BlockNumberSchema = z.string().regex(/^[1-9][0-9]*$/, "must be a positive canonical decimal block number");

const CommitmentSchema = z.strictObject({
  runSha256: Sha256Schema,
  methodSummarySha256: Sha256Schema,
  graderProgramSha256: Sha256Schema,
  sourceCommit: GitCommitSchema,
});

const ExternalBlockSchema = z.strictObject({
  source: z.literal("erc8004-block"),
  timestamp: z.string().min(1),
  chainId: z.number().int().positive().safe(),
  blockNumber: BlockNumberSchema,
  blockHash: BlockHashSchema,
});

const WitnessSchema = z.strictObject({
  commitment: CommitmentSchema,
  commitmentSha256: Sha256Schema,
  manifestCid: ManifestCidSchema,
  transactionHash: TransactionHashSchema,
  external: ExternalBlockSchema,
});

export type Demo1PreregistrationCommitment = z.infer<typeof CommitmentSchema>;
export type Demo1PreregistrationExternalBlock = z.infer<typeof ExternalBlockSchema>;
export interface Demo1PreregistrationWitness {
  readonly commitment: Demo1PreregistrationCommitment;
  readonly commitmentSha256: string;
  readonly manifestCid: string;
  readonly transactionHash: `0x${string}`;
  readonly external: Demo1PreregistrationExternalBlock;
}

export interface Demo1PreregistrationReadBack {
  readonly manifestCid: string;
  readonly transactionHash: `0x${string}`;
  readonly body: Uint8Array;
  readonly bodySha256: string;
  readonly external: Demo1PreregistrationExternalBlock;
}

/**
 * Structural composition seam over the existing generic manifest facilities. An implementation
 * maps `publishManifestBody` to the generic IPFS manifest upload, `anchorManifest` to the existing
 * ERC-8004 manifest anchor, and `readManifestAnchor` to IPFS + block read-back. The product never
 * imports, configures, or widens those packages itself.
 */
export interface Demo1PreregistrationAnchorBoundary {
  publishManifestBody(input: {
    readonly batchKind: typeof DEMO1_PREREGISTRATION_BATCH_KIND;
    readonly mediaType: typeof DEMO1_PREREGISTRATION_MEDIA_TYPE;
    readonly body: Uint8Array;
    readonly bodySha256: string;
  }): Promise<{ readonly manifestCid: string }>;
  anchorManifest(input: {
    readonly manifestCid: string;
  }): Promise<{ readonly transactionHash: `0x${string}` }>;
  readManifestAnchor(input: {
    readonly manifestCid: string;
    readonly transactionHash: `0x${string}`;
  }): Promise<Demo1PreregistrationReadBack | null>;
}

export interface Demo1PreregistrationPreDispatchResult {
  readonly stage: "post-lock-pre-dispatch";
  readonly ready: true;
  readonly runSha256: string;
  readonly manifestCid: string;
  readonly transactionHash: `0x${string}`;
  readonly externalTimestamp: string;
}

export interface Demo1PreregistrationOrderingResult {
  readonly ordered: true;
  readonly externalTimestamp: string;
  readonly firstOfficialDispatchAt: string;
}

export interface Demo1OfficialDispatchEvidenceIdentity {
  /** Position of the exact evidence entry in the supplied append-only journal. */
  readonly journalIndex: number;
  /** Digest of the complete canonical journal entry, including its timestamp and sealed fields. */
  readonly entrySha256: string;
  readonly kind: "solve-submission-accepted" | "cell-event-dispatch";
  readonly cellKey: string;
  readonly dispatch: number;
}

export interface Demo1PreregistrationRunOrderingResult extends Demo1PreregistrationOrderingResult {
  readonly firstOfficialDispatchEvidence: Demo1OfficialDispatchEvidenceIdentity;
}

function issues(error: z.ZodError): ProductIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    message: issue.message,
  }));
}

function parseCommitment(input: unknown): Demo1PreregistrationCommitment {
  const result = CommitmentSchema.safeParse(input);
  if (!result.success) refuseWithIssues("validation", issues(result.error));
  return result.data;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertCanonicalUtcTimestamp(value: string, path: string, code: "validation" | "venue-unverifiable"): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    refuse(code, path, `${path} must be a canonical UTC RFC 3339 timestamp with millisecond precision`);
  }
  return parsed;
}

function parseExternalBlock(input: unknown): Demo1PreregistrationExternalBlock {
  const result = ExternalBlockSchema.safeParse(input);
  if (!result.success) {
    refuseWithIssues("venue-unverifiable", issues(result.error).map((issue) => ({
      path: `readBack.external.${issue.path}`,
      message: issue.message,
    })));
  }
  assertCanonicalUtcTimestamp(result.data.timestamp, "readBack.external.timestamp", "venue-unverifiable");
  return result.data;
}

function parseWitness(input: unknown): Demo1PreregistrationWitness {
  const result = WitnessSchema.safeParse(input);
  if (!result.success) refuseWithIssues("venue-unverifiable", issues(result.error));
  assertCanonicalUtcTimestamp(result.data.external.timestamp, "witness.external.timestamp", "venue-unverifiable");
  return { ...result.data, transactionHash: result.data.transactionHash as `0x${string}` };
}

function assertExactCommitmentAndWitness(
  commitmentInput: unknown,
  witnessInput: unknown,
): { commitment: Demo1PreregistrationCommitment; witness: Demo1PreregistrationWitness; body: Uint8Array } {
  const commitment = parseCommitment(commitmentInput);
  const witness = parseWitness(witnessInput);
  const body = canonicalJsonBytes(commitment);
  const witnessBody = canonicalJsonBytes(witness.commitment);
  if (!Buffer.from(body).equals(Buffer.from(witnessBody))) {
    refuse("venue-unverifiable", "witness.commitment", "witness commitment does not equal the expected commitment");
  }
  if (witness.commitmentSha256 !== sha256(body)) {
    refuse("venue-unverifiable", "witness.commitmentSha256", "witness commitment digest does not match exact canonical bytes");
  }
  return { commitment, witness, body };
}

/** Returns the only bytes Demo-1 is permitted to place behind this adapter. */
export function canonicalDemo1PreregistrationCommitmentBytes(input: unknown): Uint8Array {
  return canonicalJsonBytes(parseCommitment(input));
}

/** Canonical local handoff bytes. This is not an Evidence Protocol record kind. */
export function canonicalDemo1PreregistrationWitnessBytes(input: unknown): Uint8Array {
  return canonicalJsonBytes(parseWitness(input));
}

/**
 * Uploads, anchors, and reads back one exact commitment through an injected generic-manifest
 * composition. Missing evidence, malformed receipts, non-external timestamps, or any byte/ref
 * mismatch fail closed.
 */
export async function anchorDemo1Preregistration(
  commitmentInput: unknown,
  boundary: Demo1PreregistrationAnchorBoundary,
): Promise<Demo1PreregistrationWitness> {
  const commitment = parseCommitment(commitmentInput);
  const body = canonicalJsonBytes(commitment);
  const bodySha256 = sha256(body);

  const published = await boundary.publishManifestBody({
    batchKind: DEMO1_PREREGISTRATION_BATCH_KIND,
    mediaType: DEMO1_PREREGISTRATION_MEDIA_TYPE,
    body,
    bodySha256,
  });
  const publishedResult = z.strictObject({ manifestCid: ManifestCidSchema }).safeParse(published);
  if (!publishedResult.success) refuseWithIssues("venue-unverifiable", issues(publishedResult.error));

  const anchored = await boundary.anchorManifest({ manifestCid: publishedResult.data.manifestCid });
  const anchorResult = z.strictObject({ transactionHash: TransactionHashSchema }).safeParse(anchored);
  if (!anchorResult.success) refuseWithIssues("venue-unverifiable", issues(anchorResult.error));
  const transactionHash = anchorResult.data.transactionHash as `0x${string}`;

  const readBack = await boundary.readManifestAnchor({
    manifestCid: publishedResult.data.manifestCid,
    transactionHash,
  });
  if (readBack === null) {
    refuse("venue-unverifiable", "readBack", "manifest anchor read-back is missing");
  }
  if (!(readBack.body instanceof Uint8Array)) {
    refuse("venue-unverifiable", "readBack.body", "manifest read-back body must be bytes");
  }
  if (!Buffer.from(readBack.body).equals(Buffer.from(body))) {
    refuse("venue-unverifiable", "readBack.body", "manifest read-back body does not equal the exact submitted bytes");
  }
  if (readBack.bodySha256 !== bodySha256 || sha256(readBack.body) !== bodySha256) {
    refuse("venue-unverifiable", "readBack.bodySha256", "manifest read-back digest does not match exact submitted bytes");
  }
  if (readBack.manifestCid !== publishedResult.data.manifestCid) {
    refuse("venue-unverifiable", "readBack.manifestCid", "manifest read-back CID does not match the submitted manifest CID");
  }
  if (readBack.transactionHash !== transactionHash) {
    refuse("venue-unverifiable", "readBack.transactionHash", "manifest read-back transaction does not match the anchor receipt");
  }
  const external = parseExternalBlock(readBack.external);

  return {
    commitment,
    commitmentSha256: bodySha256,
    manifestCid: publishedResult.data.manifestCid,
    transactionHash,
    external,
  };
}

/**
 * Post-lock/pre-dispatch readiness gate. Any run-journal entry is refused: the anchor must be
 * complete before the first driver or cell activity, with no inference about which entry might
 * be harmless.
 */
export function verifyDemo1PreregistrationPreDispatch(input: {
  readonly commitment: unknown;
  readonly witness: unknown;
  readonly runState: RunState;
  readonly journal: readonly RunJournalEntry[];
}): Demo1PreregistrationPreDispatchResult {
  const { commitment, witness } = assertExactCommitmentAndWitness(input.commitment, input.witness);
  if (input.runState.lockedAt === undefined || input.runState.runSha256 === undefined) {
    refuse("illegal-transition", "runState", "Demo-1 preregistration verification requires a sealed, locked Run");
  }
  if (input.runState.runSha256 !== commitment.runSha256) {
    refuse("venue-unverifiable", "runState.runSha256", "locked Run digest does not match the preregistration commitment");
  }
  if (input.runState.launchedAt !== undefined || input.journal.length !== 0) {
    refuse("illegal-transition", "runState", "preregistration readiness must be verified before launch and before any run-journal activity");
  }
  const lockedAt = assertCanonicalUtcTimestamp(input.runState.lockedAt, "runState.lockedAt", "validation");
  const anchoredAt = assertCanonicalUtcTimestamp(
    witness.external.timestamp,
    "witness.external.timestamp",
    "venue-unverifiable",
  );
  if (anchoredAt < lockedAt) {
    refuse(
      "venue-unverifiable",
      "witness.external.timestamp",
      "external anchor timestamp predates lock; E4 must be staged post-lock/pre-dispatch",
    );
  }
  return {
    stage: "post-lock-pre-dispatch",
    ready: true,
    runSha256: commitment.runSha256,
    manifestCid: witness.manifestCid,
    transactionHash: witness.transactionHash,
    externalTimestamp: witness.external.timestamp,
  };
}

/** Verifies the actual external-ordering claim once the first official dispatch time exists. */
export function verifyDemo1PreregistrationOrdering(input: {
  readonly commitment: unknown;
  readonly witness: unknown;
  readonly firstOfficialDispatchAt?: string;
}): Demo1PreregistrationOrderingResult {
  const { witness } = assertExactCommitmentAndWitness(input.commitment, input.witness);
  if (input.firstOfficialDispatchAt === undefined) {
    refuse("venue-unverifiable", "firstOfficialDispatchAt", "first official dispatch timestamp is missing");
  }
  const firstDispatch = assertCanonicalUtcTimestamp(
    input.firstOfficialDispatchAt,
    "firstOfficialDispatchAt",
    "venue-unverifiable",
  );
  const externalTimestamp = assertCanonicalUtcTimestamp(
    witness.external.timestamp,
    "witness.external.timestamp",
    "venue-unverifiable",
  );
  if (externalTimestamp >= firstDispatch) {
    refuse(
      "venue-unverifiable",
      "witness.external.timestamp",
      "external anchor timestamp must strictly precede the first official dispatch",
    );
  }
  return {
    ordered: true,
    externalTimestamp: witness.external.timestamp,
    firstOfficialDispatchAt: input.firstOfficialDispatchAt,
  };
}

/**
 * Journal-bound ordering proof. The first solve `submission-accepted` entry is the durable fact
 * that the backend accepted an official dispatch; a preceding solve `cell-event:dispatch` is also
 * accepted for boundary implementations that journal that event first. Evaluation submissions are
 * never allowed to stand in for the first official solve dispatch.
 */
export function verifyDemo1PreregistrationRunOrdering(input: {
  readonly commitment: unknown;
  readonly witness: unknown;
  readonly journal: readonly RunJournalEntry[];
}): Demo1PreregistrationRunOrderingResult {
  const qualifying = input.journal.flatMap((entry, journalIndex) => {
    const isSolveSubmission = entry.kind === "submission-accepted" && entry.leg === "solve";
    const isDispatchEvent = entry.kind === "cell-event" && entry.event.kind === "dispatch";
    if (!isSolveSubmission && !isDispatchEvent) return [];
    const atMs = assertCanonicalUtcTimestamp(entry.at, `runJournal.${journalIndex}.at`, "venue-unverifiable");
    const cellKey = entry.kind === "submission-accepted" ? entry.cellKey : entry.event.cellKey;
    const dispatch = entry.kind === "submission-accepted" ? entry.dispatch : entry.event.dispatch;
    return [{
      at: entry.at,
      atMs,
      identity: {
        journalIndex,
        entrySha256: sha256(canonicalJsonBytes(entry)),
        kind: isSolveSubmission ? "solve-submission-accepted" as const : "cell-event-dispatch" as const,
        cellKey,
        dispatch,
      },
    }];
  });
  if (qualifying.length === 0) {
    refuse("venue-unverifiable", "runJournal", "run journal does not contain a first official solve dispatch");
  }
  const first = qualifying.reduce((earliest, candidate) =>
    candidate.atMs < earliest.atMs
      || (candidate.atMs === earliest.atMs && candidate.identity.journalIndex < earliest.identity.journalIndex)
      ? candidate
      : earliest);
  const ordering = verifyDemo1PreregistrationOrdering({
    commitment: input.commitment,
    witness: input.witness,
    firstOfficialDispatchAt: first.at,
  });
  return { ...ordering, firstOfficialDispatchEvidence: first.identity };
}
