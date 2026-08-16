/**
 * Ponder schema for the Jinn protocol indexer.
 *
 * Nine entities, per spec/2026-05-11-discovery-api-and-shared-indexer.md §7 + ebu7.6 + ebu7.X + attd:
 *
 *   Task                  — from JinnRouter.TaskCreated; finalized recomputed from VerdictDeliveryClaimed
 *   Attempt               — from JinnRouter.TaskAttemptCreated
 *   Verdict               — from JinnRouter.VerdictDeliveryClaimed
 *   SolverNetManifest     — from IdentityRegistry.MetadataSet (key prefix solvernet-manifest:)
 *   Envelope              — from IdentityRegistry.MetadataSet (envelope key patterns)
 *   PluginPublication     — from IdentityRegistry.MetadataSet (key prefix plugin:) per attd /
 *                           2026-05-13-plug-in-builder-entry-point-design.md
 *   HarnessCheckpoint     — from IdentityRegistry.MetadataSet (key prefix harness.checkpoint:)
 *   AttemptEnvelopeMeta   — IPFS-enriched executor/provenance fields for execution envelopes,
 *                           keyed by (requestId, publisherAgentId, manifestCid, chainId)
 *   VerdictEnvelopeMeta   — IPFS-enriched actual outcome fields for evaluation envelopes (ebu7.X),
 *                           keyed by (requestId, publisherAgentId, manifestCid, chainId). The on-chain verdictCode
 *                           defaults to Pass(1) for failed evaluations (daemon bug); this table
 *                           holds the evaluator's real judgment from the off-chain envelope.
 *   RewardDistribution    — from Base Sepolia ExternalStakingDistributor.RewardsDistributed;
 *                           claimed OLAS/JINN staking rewards by service multisig.
 *   StakingService        — from active stOLAS staking proxy ServiceStaked;
 *                           serviceId -> multisig mapping.
 *   StakingRewardCheckpoint — from active stOLAS staking proxy Checkpoint;
 *                             earned/checkpointed OLAS by service multisig.
 *
 * Schema-version policy: any breaking change to an existing entity (rename,
 * remove, or type-change of a column) bumps the schema version and triggers a
 * re-sync from the bundled snapshot. Pure-additive changes (new columns, new
 * entities) do not require a re-sync.
 *
 * NOTE on Task.finalized / Task.refunded:
 *   JinnRouter does not emit standalone TaskFinalized or TaskRefunded events at
 *   v0.1. `finalized` is recomputed in handleVerdictDeliveryClaimed: for the
 *   current tokenless router, missing/non-positive `requiredVerdicts` means the
 *   task finalizes on the first delivered verdict. Explicit positive
 *   `requiredVerdicts` still require that many delivered verdicts (issue #530 /
 *   #1304). It is NOT set on SolutionDeliveryClaimed (that is the start of
 *   evaluation, not the end). `refunded` is set from TaskBudgetRefunded. The
 *   daemon's canClaimTask simulation compensates at claim time. See README.md
 *   §Known limitations.
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
 * One JinnRouter task. Created on TaskCreated; `finalized` recomputed on
 * VerdictDeliveryClaimed when delivered verdicts reach normalized
 * requiredVerdicts (issue #530 / #1304).
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
    // Invariant: JinnRouter emits maxClaims and requiredVerdicts as uint16
    // (0..65535). Postgres `integer` (int32) cannot overflow on this input.
    // If the ABI widens, change this column to t.bigint() and re-sync.
    /** maxClaims from TaskCreated event. */
    maxClaims: t.integer().notNull(),
    /**
     * requiredVerdicts from the TaskCreated event. The tokenless router omits
     * this field, so the handler stores 1 for new rows; old 0 rows are
     * normalized to 1 during finalization.
     */
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
     * True once delivered verdicts for any attempt reach the task's normalized
     * requiredVerdicts. For the tokenless router, missing/non-positive
     * requiredVerdicts finalize on the first verdict (#1304). Recomputed in
     * handleVerdictDeliveryClaimed; NOT set on SolutionDeliveryClaimed.
     * Monotonic.
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

// ── Verdict ──────────────────────────────────────────────────────────────────

/**
 * One verdict delivered for a task attempt. From JinnRouter.VerdictDeliveryClaimed.
 * verdictCode: 0=None, 1=Pass, 2=Fail, 3=Invalid, 4=Unresolved (the VerdictCode
 * enum in contracts/src/tasks/TaskCoordinator.sol). "Resolved" / "verdict-success"
 * = verdictCode == 1 (Pass). Per-attempt finalization (passed/failed) is derived in
 * the aggregation routes by counting Pass verdicts against requiredVerdicts; the
 * contract uses an on-chain passThreshold which is a createTask call-arg, not
 * emitted (see the claimWindow note in ponder.config.ts for the call-trace-decoding
 * follow-up).
 *
 * Primary key: (taskId, attemptIndex, verdictIndex, chainId).
 */
export const verdict = onchainTable(
  'verdict',
  (t) => ({
    taskId: t.text().notNull(),
    attemptIndex: t.integer().notNull(),
    verdictIndex: t.integer().notNull(),
    /** Evaluator Safe address that delivered the verdict. */
    evaluator: t.hex().notNull(),
    /** MechMarketplace requestId of the verdict request. */
    requestId: t.hex().notNull(),
    /** Raw verdict code: 0..4 per the VerdictCode enum. */
    verdictCode: t.integer().notNull(),
    createdAtBlock: t.bigint().notNull(),
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.taskId, table.attemptIndex, table.verdictIndex, table.chainId] }),
    taskIdx: index().on(table.taskId),
    taskAttemptIdx: index().on(table.taskId, table.attemptIndex),
    evaluatorIdx: index().on(table.evaluator),
    codeIdx: index().on(table.verdictCode),
    blockIdx: index().on(table.createdAtBlock),
  }),
);

// ── RewardDistribution ───────────────────────────────────────────────────────

/**
 * One OLAS/JINN staking reward distribution. From
 * ExternalStakingDistributor.RewardsDistributed on Base Sepolia. In this
 * testnet setup, the token named JINN represents OLAS.
 *
 * `operatorRewarded` stores the event's collectorAmount, which is the
 * operator-facing reward reserve in the current stOLAS configuration.
 */
export const rewardDistribution = onchainTable(
  'reward_distribution',
  (t) => ({
    serviceId: t.text().notNull(),
    /** The service Safe / operator multisig that earned the reward. */
    multisig: t.hex().notNull(),
    /** OLAS amount attributed to the operator-facing collector slot (wei). */
    operatorRewarded: t.bigint().notNull(),
    /** OLAS amount routed to protocol (wei). */
    protocolRewarded: t.bigint().notNull(),
    /** OLAS amount routed to curating agent (wei). */
    curatingAgentRewarded: t.bigint().notNull(),
    claimedAtBlock: t.bigint().notNull(),
    claimedAtTimestamp: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    claimedAtTx: t.hex().notNull(),
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.serviceId, table.claimedAtBlock, table.logIndex] }),
    multisigIdx: index().on(table.multisig),
    blockIdx: index().on(table.claimedAtBlock),
    timestampIdx: index().on(table.claimedAtTimestamp),
  }),
);

// ── StakingService ───────────────────────────────────────────────────────────

/**
 * Latest serviceId -> multisig mapping from the active stOLAS staking proxy.
 * Checkpoint events only carry serviceIds, so this table lets the indexer
 * attribute earned rewards to the public operator multisig without requiring a
 * claim transaction.
 */
export const stakingService = onchainTable(
  'staking_service',
  (t) => ({
    serviceId: t.text().notNull(),
    stakingProxy: t.hex().notNull(),
    owner: t.hex().notNull(),
    multisig: t.hex().notNull(),
    stakedAtBlock: t.bigint().notNull(),
    stakedAtTimestamp: t.bigint().notNull(),
    stakedAtTx: t.hex().notNull(),
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.stakingProxy, table.serviceId] }),
    multisigIdx: index().on(table.multisig),
    serviceIdx: index().on(table.serviceId),
    blockIdx: index().on(table.stakedAtBlock),
  }),
);

// ── StakingRewardCheckpoint ──────────────────────────────────────────────────

/**
 * Earned OLAS allocation from the active stOLAS Checkpoint event. This is the
 * activity signal for `/operators`: earning during the bucket matters, while
 * claiming/cashing out is operator-controlled and should not affect liveness.
 */
export const stakingRewardCheckpoint = onchainTable(
  'staking_reward_checkpoint',
  (t) => ({
    serviceId: t.text().notNull(),
    stakingProxy: t.hex().notNull(),
    multisig: t.hex().notNull(),
    epoch: t.text().notNull(),
    reward: t.bigint().notNull(),
    epochLength: t.bigint().notNull(),
    checkpointAtBlock: t.bigint().notNull(),
    checkpointAtTimestamp: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    checkpointAtTx: t.hex().notNull(),
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({
      columns: [
        table.chainId,
        table.stakingProxy,
        table.epoch,
        table.serviceId,
        table.checkpointAtBlock,
        table.logIndex,
      ],
    }),
    multisigIdx: index().on(table.multisig),
    serviceIdx: index().on(table.serviceId),
    timestampIdx: index().on(table.checkpointAtTimestamp),
    blockIdx: index().on(table.checkpointAtBlock),
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
    /**
     * keccak256(utf8 bytes of the manifest CID string). Equals Task.manifestDigest,
     * so per-SolverNet rollups join task.manifestDigest == solverNetManifest.cidKeccak.
     */
    cidKeccak: t.hex().notNull(),
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
    // ── IPFS-enriched manifest fields (ebu7.13 follow-up — `name` ask) ──────
    // The full SolverNet manifest body lives on IPFS at the `id` CID. These
    // are populated by an enrichment pass mirroring the harnessCheckpoint
    // manifest enrichment (see handlers.ts). `name` is the human-readable
    // label (e.g. 'SWE-rebench v2') used as the primary identifier in the
    // explorer UI; `description` is a short one-paragraph blurb; `solverNetId`
    // is the contract-side numeric id. Empty strings when enrichment hasn't
    // landed yet.
    name: t.text().notNull().default(''),
    description: t.text().notNull().default(''),
    solverNetId: t.text().notNull().default(''),
    // ── Full launched-SolverNet summary fields (issue #985, criterion 1) ────
    // Additive, non-breaking. Populated by the same IPFS enrichment pass that
    // fills name/description/solverNetId (see handlers.ts). Empty-string /
    // empty-array defaults when enrichment hasn't landed. Per the schema-
    // version policy above (lines 22-25), pure-additive columns do NOT bump
    // the schema version or force a re-sync. `openRoles` mirrors the
    // pluginPublication.supports text[] column (line 416).
    network: t.text().notNull().default(''),
    solutionPriceWei: t.text().notNull().default(''),
    verdictPriceWei: t.text().notNull().default(''),
    openRoles: t.text().array().notNull().default([]),
    launcherSafeAddress: t.text().notNull().default(''),
    contractId: t.text().notNull().default(''),
    contractVersion: t.text().notNull().default(''),
    /** 'pending' | 'ok' | 'failed' — enrichment lifecycle. */
    manifestEnrichmentStatus: t.text().notNull().default('pending'),
  }),
  (table) => ({
    cidKeccakIdx: index().on(table.cidKeccak),
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
 * Key parsing mirrors operator/src/corpus/onchain-query.ts::parseExecutionMetadataKey.
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

// ── PluginPublication ─────────────────────────────────────────────────────────

/**
 * A published plug-in record. Populated from IdentityRegistry.MetadataSet
 * events where the key starts with `plugin:` per
 * `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md`
 * §5.2 / §5.6.
 *
 * Primary key: composite `<builderAgentId>:<pluginCid>`. The textual `pluginCid`
 * stays primary across overwrites — version updates ship a new tarball (new cid,
 * new row), revocations overwrite the same key with a v2 revoked-marker payload
 * (same row, `revoked: true`).
 *
 * Most-recent-wins on overwrite, ordered by (blockNumber, txIndex, logIndex)
 * — matches the existing envelope tiebreak in handleMetadataSet. The
 * `publishedAt` column is the *payload-claimed* unix timestamp (from the v1
 * payload field index 5); `blockNumber` is the on-chain anchor and the
 * authoritative recency signal.
 *
 * Note on `supports`: stored as `text[]` so consumers can query for plug-ins
 * that target a specific SolverType (e.g. `swe-rebench-v2.v1`). Ponder 0.16.x
 * exposes Postgres arrays as `_in` / `_has` filter operators in its GraphQL
 * layer, satisfying the per-SolverNet browse panel in spec §6.6.
 */
export const pluginPublication = onchainTable(
  'plugin_publication',
  (t) => ({
    /** `<builderAgentId>:<pluginCid>` — composite primary key as a derived id. */
    id: t.text().primaryKey(),
    /** agentId of the builder (decimal string of the uint256). */
    builderAgentId: t.text().notNull(),
    /** IPFS CID of the packed plug-in tarball — the textual cid from the metadata key. */
    pluginCid: t.text().notNull(),
    /** npm package name from the decoded payload. */
    pluginName: t.text().notNull(),
    /** semver string from the decoded payload. */
    pluginVersion: t.text().notNull(),
    /**
     * digestDirectory output as a 32-byte hex string. Persisted as text (not
     * `t.hex()`) because the column also serves as the fork-attribution join
     * key against envelope.plugins[].sha256, which is a hex string per
     * operator/src/types/envelope.ts.
     */
    pluginSha256: t.text().notNull(),
    /** SolverType ids — indexed for SolverNet browse. */
    supports: t.text().array().notNull(),
    /** Unix seconds from the v1 payload — distinct from `blockNumber`. */
    publishedAt: t.bigint().notNull(),
    /**
     * True when the most-recent payload was a v2 revoked-marker. Defaults to
     * false on v1 inserts; flipped by a subsequent v2 overwrite to the same
     * key. A v1 re-publish to the same key (republishing a previously-revoked
     * record) is permitted and flips revoked back to false.
     */
    revoked: t.boolean().notNull().default(false),
    /** Reason string from the v2 revocation payload, nullable. */
    revokedReason: t.text(),
    /** Provenance — tx hash of the winning MetadataSet event. */
    txHash: t.hex().notNull(),
    /** Block number of the winning MetadataSet event. Used for recency ordering. */
    blockNumber: t.bigint().notNull(),
    /** Transaction index of the winning MetadataSet event. */
    txIndex: t.integer().notNull(),
    /** Log index within the block. Final tiebreaker on same-block, same-tx writes. */
    logIndex: t.integer().notNull(),
    /** Chain ID. */
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    builderIdx: index().on(table.builderAgentId),
    pluginCidIdx: index().on(table.pluginCid),
    pluginNameIdx: index().on(table.pluginName),
    supportsIdx: index().on(table.supports),
    revokedIdx: index().on(table.revoked),
    blockIdx: index().on(table.blockNumber),
  }),
);

// ── HarnessCheckpoint ────────────────────────────────────────────────────────

/**
 * A published HarnessCheckpoint anchor. From IdentityRegistry.MetadataSet with key
 * prefix `harness.checkpoint:<manifestPinCid>` (operator/src/cli/commands/checkpoint.ts).
 *
 * The on-chain value for a `harness.checkpoint:<cid>` MetadataSet is the manifest CID
 * string itself — redundant with the key, not an ABI-encoded ExecutionPayload tuple.
 * This row stores the on-chain anchor fields plus IPFS-enriched manifest body fields
 * (ebu7.9): codeDigest, parentCheckpointCid, implStateDirCid, harnessPackage fields,
 * name, version, and enrichmentStatus.
 *
 * Enrichment flow: insert with enrichmentStatus='pending', then — if enrichEnvelopes
 * is true — fetch the manifest from IPFS and update the row with the parsed fields
 * and enrichmentStatus='ok' (or 'failed' on error/parse failure). A 'failed' marker
 * allows a future batch-retry to find unenriched rows.
 *
 * Primary key: (agentId, cid, chainId).
 */
export const harnessCheckpoint = onchainTable(
  'harness_checkpoint',
  (t) => ({
    /** The checkpoint manifest CID — the part of the metadataKey after `harness.checkpoint:`. */
    cid: t.text().notNull(),
    /** agentId of the publisher (decimal string). */
    agentId: t.text().notNull(),
    /** Block number of the MetadataSet event. */
    publishedAtBlock: t.bigint().notNull(),
    /** Log index within the block. */
    logIndex: t.integer().notNull(),
    /** Chain ID. */
    chainId: t.integer().notNull(),

    // ── IPFS-enriched manifest body fields (ebu7.9) ──────────────────────────
    /** Display name from the checkpoint manifest (harnessPackage.implName). */
    name: t.text().notNull().default(''),
    /** Version string from the checkpoint manifest (harnessPackage.implVersion). */
    version: t.text().notNull().default(''),
    /**
     * sha256:<hex> code digest from the checkpoint manifest.
     * Indexed for per-codeDigest frozen-eval score queries.
     */
    codeDigest: t.text().notNull().default(''),
    /**
     * CID of the parent checkpoint, or null if this is a root checkpoint.
     * From HarnessCheckpointManifest.parentCheckpointCid.
     */
    parentCheckpointCid: t.text(),
    /** CID of the impl-state directory pinned with this checkpoint. */
    implStateDirCid: t.text().notNull().default(''),
    /** harnessPackage.implName from the checkpoint manifest. */
    implName: t.text().notNull().default(''),
    /** harnessPackage.implVersion from the checkpoint manifest. */
    implVersion: t.text().notNull().default(''),
    /**
     * harnessPackage.sourceBundleCid from the checkpoint manifest.
     * Non-empty indicates the checkpoint published its source bundle
     * (verified-frozen eligibility).
     */
    sourceBundleCid: t.text().notNull().default(''),
    /**
     * IPFS enrichment status: 'pending' | 'ok' | 'failed'.
     * 'pending' at insert; updated to 'ok' or 'failed' after the manifest fetch.
     * A 'failed' marker allows a future batch-retry worker to find and re-enrich rows.
     */
    enrichmentStatus: t.text().notNull().default('pending'),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.cid, table.chainId] }),
    cidIdx: index().on(table.cid),
    blockIdx: index().on(table.publishedAtBlock),
    codeDigestIdx: index().on(table.codeDigest),
  }),
);

// ── AttemptEnvelopeMeta ──────────────────────────────────────────────────────
/**
 * Envelope-sourced metadata for a task attempt, populated by the IPFS enrichment
 * pass (ebu7.6): for each indexed `envelope:<cid>` (execution evidence), fetch the
 * envelope body and project its executor block + provenance. Joined to `attempt`
 * by `requestId` (the envelope's `task.requestId` equals `attempt.requestId`).
 * Resilient: on IPFS fetch/parse failure no row is written (we have no requestId
 * without the body); Ponder reprocesses on the next sync giving a natural retry.
 * `mode`: 'train' (default when the envelope omits executor.mode) | 'frozen' | 'unknown'.
 *
 * Primary key: (requestId, publisherAgentId, manifestCid, chainId). A request
 * may have competing MetadataSet candidates; retaining each publisher/CID
 * anchor lets authenticated consumers reject ambiguity instead of accepting
 * whichever event happened to arrive last.
 */
export const attemptEnvelopeMeta = onchainTable(
  'attempt_envelope_meta',
  (t) => ({
    /** MechMarketplace requestId — equals attempt.requestId (the join key). */
    requestId: t.hex().notNull(),
    /** The envelope CID this metadata came from. */
    manifestCid: t.text().notNull(),
    /** ERC-8004 agentId whose MetadataSet event published this envelope. */
    publisherAgentId: t.text().notNull().default(''),
    /** Manifest hash committed in that MetadataSet event. */
    manifestHash: t.hex().notNull().default('0x'),
    /** solverType from the envelope. */
    solverType: t.text().notNull().default(''),
    /** executor.implName (harness). */
    implName: t.text().notNull().default(''),
    /** executor.implVersion. */
    implVersion: t.text().notNull().default(''),
    /** executor.codeDigest (e.g. "sha256:..."). */
    codeDigest: t.text().notNull().default(''),
    /** executor.mode: 'train' | 'frozen' | 'unknown'. */
    mode: t.text().notNull().default('train'),
    /** JSON.stringify(executor.plugins) — array of {name,version,cid?,sha256}. */
    pluginsJson: t.text().notNull().default('[]'),
    /** sessionProvenance.originatingTool: "name" or "name@version", else ''. */
    model: t.text().notNull().default(''),
    /** Best-effort language tag (repo language / payload hint), else ''. */
    language: t.text().notNull().default(''),
    /** evidenceTier from the envelope. */
    evidenceTier: t.text().notNull().default(''),
    /** True if executor.source is present (verified-frozen eligibility). */
    sourcePublished: t.boolean().notNull().default(false),
    /** 'ok' | 'failed'. (Only 'ok' rows are written today; the field is here for the future batch-retry table.) */
    enrichmentStatus: t.text().notNull().default('ok'),
    /** Block number of the MetadataSet event that triggered enrichment. */
    enrichedAtBlock: t.bigint().notNull(),
    /** Chain ID. */
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.requestId, table.publisherAgentId, table.manifestCid, table.chainId] }),
    requestChainIdx: index().on(table.requestId, table.chainId),
    manifestCidIdx: index().on(table.manifestCid),
    implNameIdx: index().on(table.implName),
    modeIdx: index().on(table.mode),
    /** Per-(operator, codeDigest) reward aggregates (DR-2026-05-27 §4.2 Level 1). */
    codeDigestIdx: index().on(table.codeDigest),
  }),
);

// ── VerdictEnvelopeMeta ──────────────────────────────────────────────────────
/**
 * Envelope-sourced metadata for a delivered verdict, populated by the IPFS
 * enrichment pass (ebu7.X): for each indexed `evaluation:<cid>` MetadataSet
 * event, fetch the evaluation envelope body and project its actual outcome.
 *
 * Background: the on-chain `JinnRouter.VerdictDeliveryClaimed.verdictCode`
 * defaults to Pass(1) for failed evaluations (daemon bug in
 * `operator/src/adapters/mech/adapter.ts:899` + engine.ts fall-through).
 * The evaluator's real judgment is written correctly in the off-chain
 * evaluation envelope on IPFS (anchored via `IdentityRegistry.MetadataSet`
 * with key `evaluation:<cid>`). This table is the source of truth for whether
 * an evaluation actually passed or failed.
 *
 * Join: `(requestId, chainId)` → `verdict`.
 * Also joinable to `attempt` via `requestId`.
 *
 * Resilient: on IPFS fetch/parse failure no row is written (we have no PK
 * without the body); Ponder reprocesses on the next sync giving a natural
 * retry. `enrichmentStatus` documents the last attempt result.
 *
 * `actualPassed` is the source of truth. `verdict.verdictCode` is what was
 * submitted on-chain (often defaulted to Pass). When both are present and
 * disagree, prefer `actualPassed` in UI and metrics.
 *
 * Primary key: (requestId, publisherAgentId, manifestCid, chainId). A request
 * may have competing MetadataSet candidates; retaining each publisher/CID
 * anchor lets authenticated consumers reject ambiguity instead of accepting
 * whichever event happened to arrive last.
 * Index on manifestCid, evaluator, actualPassed, evaluatorVerdict, taskId.
 */
export const verdictEnvelopeMeta = onchainTable(
  'verdict_envelope_meta',
  (t) => ({
    /** MechMarketplace requestId — equals verdict.requestId (the join key). */
    requestId: t.hex().notNull(),
    /**
     * Best-effort verdict index within the attempt. Some historical envelopes
     * omit it, so route joins use requestId as the stable verdict identity.
     */
    verdictIndex: t.integer().notNull(),
    /** Best-effort attempt index, from the envelope's task.attemptIndex if present. */
    attemptIndex: t.integer().notNull().default(0),
    /** The bigint task id as a decimal string, from the envelope. */
    taskId: t.text().notNull().default(''),
    /** participant.safeAddress from the envelope (evaluator Safe address). */
    evaluator: t.hex().notNull().default('0x'),
    /** The envelope IPFS CID (from the metadata key `evaluation:<cid>`). */
    manifestCid: t.text().notNull(),
    /** ERC-8004 agentId whose MetadataSet event published this envelope. */
    publisherAgentId: t.text().notNull().default(''),
    /** Manifest hash committed in that MetadataSet event. */
    manifestHash: t.hex().notNull().default('0x'),
    /** solverType from the envelope. */
    solverType: t.text().notNull().default(''),
    /** evidenceTier from the envelope. */
    evidenceTier: t.text().notNull().default(''),
    /**
     * TRUE iff the evaluator's actual judgment was a pass.
     * For swe-rebench-v2: from payload.passed_match.
     * For other solverTypes: from payload.verdict === 'PASS'.
     * This is the source of truth; on-chain verdictCode often defaults to Pass.
     */
    actualPassed: t.boolean().notNull().default(false),
    /**
     * Numeric score where one exists, as a string (e.g. "1.0" / "0.0").
     * Populated for swe-rebench-v2 from payload.score. Empty for other types.
     */
    actualScore: t.text().notNull().default(''),
    /**
     * Graded per-test counts (Lever A, #1019). Populated for swe-rebench-v2
     * verdict.v2 envelopes from payload.passedCount / payload.totalCount.
     * 0/0 for v1 envelopes and non-swe-rebench-v2 types. gradedScore
     * (= passedCount/totalCount) is derived at read time, never stored.
     * Read ONLY by the learner discovery query — never by emissions.
     */
    passedCount: t.integer().notNull().default(0),
    totalCount: t.integer().notNull().default(0),
    /**
     * SWE-rebench v2 instance identifier (e.g. 'sympy__sympy-27510'). Populated
     * by the IPFS enrichment pass: when solverType starts with 'swe-rebench-v2',
     * the handler fetches the task body via the envelope's task.cid and reads
     * spec.instance_id. Empty string for other solverTypes (they have no
     * instance_id concept) and for swe-rebench-v2 envelopes whose task body
     * could not be fetched. Indexed alongside manifestCid + actualPassed so the
     * launcher's getInstanceSuccessCounts can filter cheaply.
     *
     * Spec: issue #669 — launcher under-counts successes when verdicts arrive
     * via other operators' delivery-watchers.
     */
    instanceId: t.text().notNull().default(''),
    /**
     * SolverNet manifest CID the task was posted under, read from the task
     * body's top-level `solverNetManifestCid` field (task.v1 schema; see
     * `operator/src/types/task-document.ts`). Populated in the same IPFS task-body
     * fetch that resolves `instanceId`, so the read pays no extra round-trip.
     * Empty string when the enrichment branch did not run (non-swe-rebench-v2
     * solverTypes) or when the task body was unfetchable.
     *
     * Scopes `getInstanceSuccessCounts` to a single SolverNet so multi-SolverNet
     * operators with overlapping instance_id pools don't cross-tenant
     * over-count: successes on SolverNet-B no longer saturate SolverNet-A's
     * launcher. Spec: issue #669 (Finding 2 — manifest-scoped success counts).
     */
    solverNetManifestCid: t.text().notNull().default(''),
    /**
     * The SOLVE-request id (MechMarketplace requestId of the solution attempt),
     * read from the task body's top-level `restorationRequestId` field (task.v1
     * schema; see `operator/src/types/task.ts`). Makes the knowledge tuple
     * `(task, solution, verdict)` a first-class GraphQL join:
     * `verdictEnvelopeMeta.solutionRequestId = attemptEnvelopeMeta.requestId`
     * resolves a verified verdict to its solution envelope with no extra IPFS
     * fetches.
     *
     * The verdict's own `requestId` is the EVALUATION request and does NOT
     * cross-match `attempt.requestId` (the SOLVE request) — verified live, 0
     * intersection. The link is this field. Populated in the same IPFS
     * task-body fetch that resolves `instanceId` / `solverNetManifestCid`, so
     * the read pays no extra round-trip. Empty string when the enrichment branch
     * did not run (non-swe-rebench-v2 solverTypes), the task body was
     * unfetchable, or the task body omitted `restorationRequestId`. Spec: issue
     * #1433.
     */
    solutionRequestId: t.text().notNull().default(''),
    /**
     * Normalized off-chain verdict: 'PASS' | 'FAIL' | 'INVALID' | 'INDETERMINATE' | 'UNKNOWN'.
     * 'UNKNOWN' when the envelope body lacks a recognizable verdict field.
     */
    evaluatorVerdict: t.text().notNull().default('UNKNOWN'),
    /**
     * 'pending' | 'retry' | 'ok' | 'failed'.
     * Current #779 worker writes only 'ok' rows here. Pre-requestId
     * verdict-body failures are tracked in the worker-owned enrichment_attempt
     * table because this table's primary key is inside the body. The other
     * statuses remain for compatibility with any pre-existing/future row-keyed
     * retry path and are still honoured by worker discovery.
     */
    enrichmentStatus: t.text().notNull().default('pending'),
    /**
     * Row-keyed retry counter retained for compatibility/future use. The #779
     * worker's verdict-body retry counter lives in enrichment_attempt.
     */
    retryCount: t.integer().notNull().default(0),
    /**
     * Epoch-ms for row-keyed retry eligibility, nullable. The #779 worker uses
     * enrichment_attempt.next_attempt_at for verdict-body retry/backoff, but
     * still honours this field for any pre-existing pending/retry rows.
     */
    nextAttemptAt: t.bigint(),
    /** Block number of the MetadataSet event that triggered enrichment. */
    enrichedAtBlock: t.bigint().notNull(),
    /** Chain ID. */
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.requestId, table.publisherAgentId, table.manifestCid, table.chainId] }),
    requestChainIdx: index().on(table.requestId, table.chainId),
    manifestCidIdx: index().on(table.manifestCid),
    evaluatorIdx: index().on(table.evaluator),
    actualPassedIdx: index().on(table.actualPassed),
    evaluatorVerdictIdx: index().on(table.evaluatorVerdict),
    taskIdIdx: index().on(table.taskId),
    // Join key for the (task, solution, verdict) tuple: pairs a verified
    // verdict to its solution envelope via
    // solutionRequestId == attemptEnvelopeMeta.requestId (#1433).
    solutionRequestIdIdx: index().on(table.solutionRequestId),
    // Supports worker discovery for any pre-existing row-keyed pending/retry
    // verdict rows.
    dueIdx: index().on(table.enrichmentStatus, table.nextAttemptAt),
    instanceIdIdx: index().on(table.manifestCid, table.actualPassed, table.instanceId),
    // Filter shape used by getInstanceSuccessCounts (#669 Finding 2): scope
    // success counts to a single SolverNet so multi-SolverNet operators don't
    // cross-tenant over-count.
    solverNetInstanceIdIdx: index().on(
      table.solverNetManifestCid,
      table.actualPassed,
      table.instanceId,
    ),
  }),
);

// ── CaptureEnvelopeMeta ──────────────────────────────────────────────────────
/**
 * Envelope-sourced metadata for a published capture, populated
 * by the IPFS enrichment pass (issue #1314): for each indexed `capture:<cid>`
 * MetadataSet event, fetch the wrapper envelope body, then its canonical
 * `jinn.episode.v1` artifact (or frozen `jinn.trace-envelope.v0` compatibility
 * artifact), and project the fields the distribution signal and corpus read.
 *
 * Seeds (`provenance: 'imported'`) are stored but EXCLUDED from the signal's
 * default counts — the API filters on this column (spec §7).
 *
 * Resilient: on IPFS fetch/parse failure no row is written; Ponder reprocesses
 * on the next sync giving a natural retry.
 *
 * Primary key: (manifestCid, chainId) — the wrapper envelope CID is the
 * corpus ref, one meta row per published capture.
 */
export const captureEnvelopeMeta = onchainTable(
  'capture_envelope_meta',
  (t) => ({
    /** The wrapper envelope CID (the corpus ref) — part of the metadataKey after `capture:`. */
    manifestCid: t.text().notNull(),
    /** Chain ID. */
    chainId: t.integer().notNull(),
    /** agentId of the publisher (decimal string). */
    agentId: t.text().notNull(),
    /** Contributor identity: participant.safeAddress from the wrapper envelope. */
    contributor: t.text().notNull().default(''),
    /** Scrubbed one-line task summary from the evidence payload. */
    taskSummary: t.text().notNull().default(''),
    /** JSON.stringify(task.distributionTags) — first tag is the primary (v0 cluster key). */
    tagsJson: t.text().notNull().default('[]'),
    /** task.repositorySlug — retained for tuple joins and corpus attribution (#1842). */
    repositorySlug: t.text().notNull().default(''),
    /** Authored outcome/seed synthesis retained as record metadata (#1842). */
    synthesis: t.text().notNull().default(''),
    /** Named W2 retrieval-visibility projection; false for substrate-only records. */
    retrievalVisible: t.boolean().notNull().default(false),
    /** 'contributed' | 'imported' — the signal's seed-exclusion filter column. */
    provenance: t.text().notNull().default('contributed'),
    /** Compatibility column: Episode verificationStrength or trace verifiabilityTier. */
    verifiabilityTier: t.text().notNull().default(''),
    /** environment.harness — "<name> <version>", empty when absent. Corpus detail (#1406). */
    harness: t.text().notNull().default(''),
    /** environment.model, empty when absent. Corpus detail (#1406). */
    model: t.text().notNull().default(''),
    /** JSON.stringify(environment.tools) — tool names only. Corpus detail (#1406). */
    toolsJson: t.text().notNull().default('[]'),
    /** trajectory.length / legacy steps.length. Corpus index + detail (#1406). */
    stepCount: t.integer().notNull().default(0),
    /** Transaction hash of the MetadataSet anchor event — the on-chain anchor link (#1406). */
    anchorTx: t.hex().notNull().default('0x'),
    /** Unix-seconds block timestamp of the anchor event — the corpus item's createdAt (#1406). */
    createdAtTimestamp: t.bigint().notNull().default(0n),
    /** 'ok' | 'failed'. */
    enrichmentStatus: t.text().notNull().default('ok'),
    /** Block number of the MetadataSet event that triggered enrichment. */
    enrichedAtBlock: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.manifestCid, table.chainId] }),
    provenanceIdx: index().on(table.provenance),
    contributorIdx: index().on(table.contributor),
    createdAtIdx: index().on(table.createdAtTimestamp),
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

export const verdictRelations = relations(verdict, ({ one }) => ({
  task: one(task, { fields: [verdict.taskId], references: [task.id] }),
}));
