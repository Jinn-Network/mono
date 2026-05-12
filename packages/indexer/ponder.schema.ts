/**
 * Ponder schema for the Jinn protocol indexer.
 *
 * Four entities, per spec/2026-05-11-discovery-api-and-shared-indexer.md §7:
 *
 *   Task            — from JinnRouter.TaskCreated / SolutionDeliveryClaimed
 *   Attempt         — from JinnRouter.TaskAttemptCreated
 *   SolverNetManifest — from IdentityRegistry.MetadataSet (key prefix solvernet-manifest:)
 *   Envelope        — from IdentityRegistry.MetadataSet (envelope key patterns)
 *
 * Schema-version policy: any breaking change to an existing entity (rename,
 * remove, or type-change of a column) bumps the schema version and triggers a
 * re-sync from the bundled snapshot. Pure-additive changes (new columns, new
 * entities) do not require a re-sync.
 *
 * NOTE on Task.finalized / Task.refunded:
 *   JinnRouter does not emit standalone TaskFinalized or TaskRefunded events at
 *   v0.1. The finalized flag is set to true when a SolutionDeliveryClaimed event
 *   is received for a task (indicating the solution delivery was claimed by the
 *   operator, which is the terminal success state). refunded remains false in the
 *   indexer until contract events are added; the daemon's canClaimTask simulation
 *   compensates at claim time. See README.md §Known limitations.
 *
 * NOTE on claimWindowStart / claimWindowEnd:
 *   These fields are not emitted in the TaskCreated event on JinnRouter V3. They
 *   are passed as part of the `policy` tuple in the createTask function call. To
 *   populate them, the handler would need to decode the originating transaction
 *   input (using includeTransactionReceipts or call traces). At v0.1 these fields
 *   are stored as nullable integers; a follow-up task (280n.4) can enable
 *   includeCallTraces in ponder.config.ts to decode them. The daemon's
 *   findClaimableTasks compensates by passing nowSeconds and the on-chain
 *   canClaimTask simulation as the correctness gate.
 */
import { onchainTable, index, relations, primaryKey } from 'ponder';

// ── Task ─────────────────────────────────────────────────────────────────────

/**
 * One JinnRouter task. Created on TaskCreated, marked finalized on
 * SolutionDeliveryClaimed.
 *
 * Supports findClaimableTasks: filter by manifestDigest, finalized, refunded;
 * join with Attempt for attempt/operatorAttempt counts.
 */
export const task = onchainTable(
  'task',
  (t) => ({
    /** taskId as string (uint256 → decimal string). Primary key. */
    id: t.text().primaryKey(),
    /** keccak256 of the manifest CID string. Indexed for manifest-digest lookups. */
    manifestDigest: t.hex().notNull(),
    /** keccak256 of the task CID content. */
    taskCidDigest: t.hex().notNull(),
    /** EOA/Safe that called createTask. */
    creator: t.hex().notNull(),
    /** maxClaims from TaskCreated event. */
    maxClaims: t.integer().notNull(),
    /** requiredVerdicts from the TaskCreated event — verdicts needed before an attempt finalizes. */
    requiredVerdicts: t.integer().notNull().default(0),
    /** Block number of the TaskCreated event. */
    createdAtBlock: t.bigint().notNull(),
    /** Transaction hash of the TaskCreated event. */
    createdAtTx: t.hex().notNull(),
    /**
     * claimWindowStart (unix seconds). Not emitted by JinnRouter V3 TaskCreated;
     * populated as null until call-trace decoding lands in 280n.4.
     */
    claimWindowStart: t.bigint(),
    /**
     * claimWindowEnd (unix seconds). Not emitted by JinnRouter V3 TaskCreated;
     * populated as null until call-trace decoding lands in 280n.4.
     */
    claimWindowEnd: t.bigint(),
    /**
     * True when a SolutionDeliveryClaimed event is received for this task.
     * JinnRouter V3 has no standalone TaskFinalized event; this is the
     * best available proxy at v0.1.
     */
    finalized: t.boolean().notNull().default(false),
    /**
     * True when a refund event is received for this task.
     * JinnRouter V3 has no TaskRefunded event at v0.1; always false.
     * See README.md §Known limitations.
     */
    refunded: t.boolean().notNull().default(false),
    /** Chain ID where this task lives. */
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    manifestIdx: index().on(table.manifestDigest),
    finalizedIdx: index().on(table.finalized),
  }),
);

// ── Attempt ──────────────────────────────────────────────────────────────────

/**
 * One task attempt. Created on TaskAttemptCreated.
 *
 * Supports findClaimableTasks: count total attempts and operator-specific
 * attempts per task by querying attempts WHERE taskId = $id.
 *
 * Composite primary key: (taskId, attemptIndex, chainId) — multiple attempts
 * per task, and the same logical task may be indexed on multiple chains in
 * future multi-chain configurations.
 */
export const attempt = onchainTable(
  'attempt',
  (t) => ({
    /** taskId as decimal string. */
    taskId: t.text().notNull(),
    /** Attempt index within the task (uint32). */
    attemptIndex: t.integer().notNull(),
    /** MechMarketplace requestId for this attempt. */
    requestId: t.hex().notNull(),
    /** Operator Safe address that claimed the task. */
    operator: t.hex().notNull(),
    /** Priority mech address. */
    priorityMech: t.hex().notNull(),
    /** Delivery rate at time of claim (wei). */
    deliveryRate: t.bigint().notNull(),
    /** Block number of the TaskAttemptCreated event. */
    createdAtBlock: t.bigint().notNull(),
    /** Chain ID. */
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.taskId, table.attemptIndex, table.chainId] }),
    taskIdx: index().on(table.taskId),
    operatorIdx: index().on(table.operator),
    taskOperatorIdx: index().on(table.taskId, table.operator),
  }),
);

// ── SolverNetManifest ─────────────────────────────────────────────────────────

/**
 * Current lifecycle state of a launched SolverNet. Populated from
 * IdentityRegistry.MetadataSet events where the key starts with
 * `solvernet-manifest:`. Most-recent-wins semantics: each upsert overwrites
 * the status fields if the new event is from the same or a later block.
 *
 * Supports listLaunchedSolverNets and getLifecycleStatus.
 */
export const solverNetManifest = onchainTable(
  'solver_net_manifest',
  (t) => ({
    /** manifestCid — the IPFS CID after the `solvernet-manifest:` prefix. Primary key. */
    id: t.text().primaryKey(),
    /** agentId of the launcher (decimal string of the uint256). */
    launcherAgentId: t.text().notNull(),
    /**
     * Current lifecycle status: 'launched' | 'paused' | 'retired'.
     * Set by the most-recent MetadataSet payload for this (agentId, cid) tuple.
     */
    status: t.text().notNull(),
    /** ISO-8601 timestamp string from the lifecycle payload's `at` field. */
    statusUpdatedAt: t.text().notNull(),
    /**
     * keccak256 hash of the manifest content from the lifecycle payload.
     * Used to verify IPFS content on retrieval.
     */
    manifestHash: t.hex().notNull(),
    /** Block number of the winning MetadataSet event. */
    anchorBlock: t.bigint().notNull(),
    /** Transaction index of the winning MetadataSet event (for tiebreaking). */
    anchorTransactionIndex: t.integer().notNull(),
    /**
     * Log index of the winning MetadataSet event within its block. Final
     * tiebreaker so two lifecycle updates in the same transaction (same block,
     * same tx index) resolve deterministically — later log wins.
     */
    anchorLogIndex: t.integer().notNull(),
    /** Chain ID. */
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    launcherIdx: index().on(table.launcherAgentId),
    statusIdx: index().on(table.status),
    chainIdx: index().on(table.chainId),
  }),
);

// ── Envelope ─────────────────────────────────────────────────────────────────

/**
 * Corpus envelope reference. Populated from IdentityRegistry.MetadataSet
 * events where the key matches the envelope key pattern:
 *   `envelope:<manifestCid>`  — execution evidence envelope
 *   `evaluation:<manifestCid>` — evaluation verdict envelope
 *   `capture:<manifestCid>`   — capture envelope
 *
 * Key parsing mirrors client/src/corpus/onchain-query.ts::parseExecutionMetadataKey.
 *
 * Supports queryEnvelopes: filter by kind, evidenceTier.
 * solverType is in the IPFS manifest body, not on-chain — not filterable here.
 * Ordered by publishedAtBlock desc for recency.
 *
 * Primary key: (agentId, metadataKey, chainId) — an agent can publish multiple
 * envelope refs, one per manifest CID. Using the full key avoids collisions
 * between envelope / evaluation / capture kinds for the same CID.
 */
export const envelope = onchainTable(
  'envelope',
  (t) => ({
    /** agentId of the publisher (decimal string). */
    agentId: t.text().notNull(),
    /**
     * Full metadata key (e.g. `envelope:bafyrei...`).
     * Part of primary key; used as a dedup signal.
     */
    metadataKey: t.text().notNull(),
    /** Chain ID. */
    chainId: t.integer().notNull(),
    /**
     * Key kind: 'envelope' | 'evaluation' | 'capture'.
     * Extracted from the metadataKey prefix before the colon.
     */
    kind: t.text().notNull(),
    /** The manifest CID portion of the metadataKey (after the colon). */
    manifestCid: t.text().notNull(),
    /**
     * manifestHash from the ABI-decoded payload (bytes32 field index 2).
     * Hex string; used by the corpus library to verify content on retrieval.
     */
    manifestHash: t.hex().notNull(),
    /**
     * Evidence tier from the ABI-decoded payload (uint8 field index 1).
     * Values: 0=self-signed, 1=committed, 3=attested. Stored as text for
     * readability and GraphQL filtering.
     */
    evidenceTier: t.text().notNull(),
    /** Block number of the MetadataSet event. Used for recency ordering. */
    publishedAtBlock: t.bigint().notNull(),
    /** Log index within the block (secondary sort key). */
    logIndex: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.metadataKey, table.chainId] }),
    kindIdx: index().on(table.kind),
    manifestCidIdx: index().on(table.manifestCid),
    evidenceTierIdx: index().on(table.evidenceTier),
    blockIdx: index().on(table.publishedAtBlock),
  }),
);

// ── Relations ─────────────────────────────────────────────────────────────────

export const taskRelations = relations(task, ({ many }) => ({
  attempts: many(attempt),
}));

export const attemptRelations = relations(attempt, ({ one }) => ({
  task: one(task, {
    fields: [attempt.taskId],
    references: [task.id],
  }),
}));
