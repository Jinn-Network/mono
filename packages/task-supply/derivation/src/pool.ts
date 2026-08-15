// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { canonicalJsonBytes, type CanonicalJsonValue } from "./canonical.js";
import { assertPrefixedDigest, documentDigest, type Sha256Digest } from "./digest.js";
import { DerivationError } from "./errors.js";
import type { UpstreamIdentity } from "./source-commitment.js";

export const POOL_ENTRY_SCHEMA_VERSION = 1 as const;

/** Lineage of a synthetic instance: which template, which parameters, which environment. */
export interface SyntheticLineage {
  readonly templateId: string;
  readonly templateVersion: string;
  readonly parameterDigest: Sha256Digest;
  readonly environmentRecordDigest: Sha256Digest;
}

export type PoolEntryProvenance =
  | {
      readonly kind: "mined";
      readonly sourceCommitment: Sha256Digest;
      readonly upstream: UpstreamIdentity;
    }
  | {
      readonly kind: "synthetic";
      readonly sourceCommitment: Sha256Digest;
      readonly lineage: SyntheticLineage;
    };

/**
 * What the pool records about a pair. Deliberately absent: any timestamp, any status flag
 * (§12 — all such state is derived projection), and any field that could carry gold
 * material.
 */
export interface PoolEntrySummary {
  readonly taskDigest: Sha256Digest;
  readonly evaluationSpecDigest: Sha256Digest;
  /** The admission receipt this pair earned; the receipt bytes live in the evidence store. */
  readonly receiptDigest: Sha256Digest;
  readonly environmentRecordDigest: Sha256Digest;
  readonly strategyId: string;
  readonly provenance: PoolEntryProvenance;
  readonly rights: { readonly sourceLicense: string };
}

export interface PoolEntry extends PoolEntrySummary {
  readonly taskBytes: Uint8Array;
  readonly evaluationSpecBytes: Uint8Array;
}

/**
 * The derivation unit's output store (design §3.2: the pool is this unit's store, not a
 * standalone unit). Digest-addressed: an entry's address is its Task digest.
 */
export interface SupplyPool {
  put(entry: PoolEntry): Promise<PoolEntrySummary>;
  get(taskDigest: string): Promise<PoolEntry | undefined>;
  list(): Promise<readonly PoolEntrySummary[]>;
}

const PrefixedDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const MinedProvenanceSchema = z.strictObject({
  kind: z.literal("mined"),
  sourceCommitment: PrefixedDigest,
  upstream: z.strictObject({
    dataset: z.string().min(1),
    revision: z.string().min(1),
    instanceId: z.string().min(1),
  }),
});

const SyntheticProvenanceSchema = z.strictObject({
  kind: z.literal("synthetic"),
  sourceCommitment: PrefixedDigest,
  lineage: z.strictObject({
    templateId: z.string().min(1),
    templateVersion: z.string().min(1),
    parameterDigest: PrefixedDigest,
    environmentRecordDigest: PrefixedDigest,
  }),
});

export const PoolEntryManifestSchema = z.strictObject({
  schemaVersion: z.literal(POOL_ENTRY_SCHEMA_VERSION),
  taskDigest: PrefixedDigest,
  evaluationSpecDigest: PrefixedDigest,
  receiptDigest: PrefixedDigest,
  environmentRecordDigest: PrefixedDigest,
  strategyId: z.string().min(1),
  provenance: z.discriminatedUnion("kind", [MinedProvenanceSchema, SyntheticProvenanceSchema]),
  rights: z.strictObject({ sourceLicense: z.string().min(1) }),
});

function provenanceBody(provenance: PoolEntryProvenance): CanonicalJsonValue {
  return provenance.kind === "mined"
    ? {
        kind: "mined",
        sourceCommitment: provenance.sourceCommitment,
        upstream: {
          dataset: provenance.upstream.dataset,
          revision: provenance.upstream.revision,
          instanceId: provenance.upstream.instanceId,
        },
      }
    : {
        kind: "synthetic",
        sourceCommitment: provenance.sourceCommitment,
        lineage: {
          templateId: provenance.lineage.templateId,
          templateVersion: provenance.lineage.templateVersion,
          parameterDigest: provenance.lineage.parameterDigest,
          environmentRecordDigest: provenance.lineage.environmentRecordDigest,
        },
      };
}

export function poolEntryManifestBytes(summary: PoolEntrySummary): Uint8Array {
  return canonicalJsonBytes({
    schemaVersion: POOL_ENTRY_SCHEMA_VERSION,
    taskDigest: summary.taskDigest,
    evaluationSpecDigest: summary.evaluationSpecDigest,
    receiptDigest: summary.receiptDigest,
    environmentRecordDigest: summary.environmentRecordDigest,
    strategyId: summary.strategyId,
    provenance: provenanceBody(summary.provenance),
    rights: { sourceLicense: summary.rights.sourceLicense },
  });
}

/**
 * The manifest fields that make two entries *the same claim*, with `receiptDigest` removed.
 *
 * A pair can be admitted more than once — a second run over the same rows re-runs admission
 * and earns a second, equally valid receipt. That is not a conflict: the sealed pair is
 * identical and the pool is addressed by it. What IS a conflict is a second entry at the same
 * address claiming a different strategy, provenance or licence, none of which the Task digest
 * commits to. So re-putting is idempotent on everything except which receipt got recorded
 * first, and first writer wins there.
 */
export function poolEntryConflictKeyBytes(summary: PoolEntrySummary): Uint8Array {
  return canonicalJsonBytes({
    taskDigest: summary.taskDigest,
    evaluationSpecDigest: summary.evaluationSpecDigest,
    environmentRecordDigest: summary.environmentRecordDigest,
    strategyId: summary.strategyId,
    provenance: provenanceBody(summary.provenance),
    rights: { sourceLicense: summary.rights.sourceLicense },
  });
}

export function parsePoolEntryManifest(bytes: Uint8Array): PoolEntrySummary {
  const parsed = PoolEntryManifestSchema.safeParse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (!parsed.success) {
    throw new DerivationError(
      "invalid-input",
      `pool entry manifest is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const { schemaVersion: _schemaVersion, ...summary } = parsed.data;
  return summary as PoolEntrySummary;
}

/** The pool is digest-addressed only if the address is checked against the bytes. */
export function assertEntryDigests(entry: PoolEntry): void {
  const task = documentDigest(entry.taskBytes);
  if (task !== assertPrefixedDigest(entry.taskDigest, "entry.taskDigest")) {
    throw new DerivationError(
      "pool-conflict",
      `entry taskDigest ${entry.taskDigest} does not address its bytes (${task}).`,
    );
  }
  const spec = documentDigest(entry.evaluationSpecBytes);
  if (spec !== assertPrefixedDigest(entry.evaluationSpecDigest, "entry.evaluationSpecDigest")) {
    throw new DerivationError(
      "pool-conflict",
      `entry evaluationSpecDigest ${entry.evaluationSpecDigest} does not address its bytes (${spec}).`,
    );
  }
}
