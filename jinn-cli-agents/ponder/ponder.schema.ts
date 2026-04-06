import { onchainTable, index } from "ponder";
// build_id bust: v35 — ventureId/templateId inheritance from workstream root + root request fallback

export const jobDefinition = onchainTable(
  "job_definition",
  (t) => ({
    id: t.text().primaryKey(),
    name: t.text(),
    enabledTools: t.text().array(),
    blueprint: t.text(),
    workstreamId: t.text(),
    ventureId: t.text(),
    templateId: t.text(),
    sourceJobDefinitionId: t.text(),
    sourceRequestId: t.text(),
    codeMetadata: t.json(),
    dependencies: t.text().array(),
    createdAt: t.bigint(),
    lastInteraction: t.bigint(),
    lastStatus: t.text(),
    latestStatusUpdate: t.text(),
    latestStatusUpdateAt: t.bigint(), // Timestamp when latestStatusUpdate was captured (separate from lastInteraction)
  }),
  (table) => ({
    nameIdx: index().on(table.name),
    workstreamIdIdx: index().on(table.workstreamId),
    ventureIdIdx: index().on(table.ventureId),
    templateIdIdx: index().on(table.templateId),
    sourceJobDefIdx: index().on(table.sourceJobDefinitionId),
    sourceReqIdx: index().on(table.sourceRequestId),
    lastInteractionIdx: index().on(table.lastInteraction),
  })
);

export const request = onchainTable(
  "request",
  (t) => ({
    id: t.text().primaryKey(),
    mech: t.hex().notNull(),
    sender: t.hex().notNull(),
    workstreamId: t.text(),
    ventureId: t.text(),
    templateId: t.text(),
    jobDefinitionId: t.text(),
    sourceRequestId: t.text(),
    sourceJobDefinitionId: t.text(),
    requestData: t.text(),
    ipfsHash: t.text(),
    deliveryIpfsHash: t.text(),
    deliveryMech: t.hex(), // Mech that actually delivered (from MarketplaceDelivery event)
    transactionHash: t.text(),
    blockNumber: t.bigint().notNull(),
    blockTimestamp: t.bigint().notNull(),
    delivered: t.boolean().notNull(),
    jobName: t.text(),
    enabledTools: t.text().array(),
    additionalContext: t.json(),
    dependencies: t.text().array(),
  }),
  (table) => ({
    ts: index().on(table.blockTimestamp),
    mechIdx: index().on(table.mech),
    deliveryMechIdx: index().on(table.deliveryMech),
    senderIdx: index().on(table.sender),
    workstreamIdIdx: index().on(table.workstreamId),
    ventureIdIdx: index().on(table.ventureId),
    templateIdIdx: index().on(table.templateId),
    jobDefIdx: index().on(table.jobDefinitionId),
    sourceReqIdx: index().on(table.sourceRequestId),
    sourceJobDefIdx: index().on(table.sourceJobDefinitionId),
  })
);

export const delivery = onchainTable(
  "delivery",
  (t) => ({
    id: t.text().primaryKey(),
    requestId: t.text().notNull(),
    sourceRequestId: t.text(),
    sourceJobDefinitionId: t.text(),
    mech: t.hex().notNull(),
    mechServiceMultisig: t.hex().notNull(),
    deliveryMech: t.hex(), // Mech that actually delivered (from MarketplaceDelivery event)
    deliveryRate: t.bigint().notNull(),
    ipfsHash: t.text(),
    transactionHash: t.text().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTimestamp: t.bigint().notNull(),
    jobInstanceStatusUpdate: t.text(),
  }),
  (table) => ({
    ts: index().on(table.blockTimestamp),
    mechIdx: index().on(table.mech),
    deliveryMechIdx: index().on(table.deliveryMech),
    requestIdIdx: index().on(table.requestId),
    sourceReqIdx: index().on(table.sourceRequestId),
    sourceJobDefIdx: index().on(table.sourceJobDefinitionId),
  })
);

export const artifact = onchainTable(
  "artifact",
  (t) => ({
    id: t.text().primaryKey(),
    requestId: t.text().notNull(),
    sourceRequestId: t.text(),
    sourceJobDefinitionId: t.text(),
    ventureId: t.text(),
    workstreamId: t.text(),
    templateId: t.text(),
    name: t.text().notNull(),
    cid: t.text().notNull(),
    contentCid: t.text(),
    topic: t.text().notNull(),
    contentPreview: t.text(),
    blockTimestamp: t.bigint().notNull(),
    type: t.text(),
    documentType: t.text(),
    tags: t.text().array(),
    utilityScore: t.integer(),
    accessCount: t.integer(),
  }),
  (table) => ({
    requestIdIdx: index().on(table.requestId),
    sourceReqIdx: index().on(table.sourceRequestId),
    sourceJobDefIdx: index().on(table.sourceJobDefinitionId),
    ventureIdIdx: index().on(table.ventureId),
    workstreamIdIdx: index().on(table.workstreamId),
    templateIdIdx: index().on(table.templateId),
    topicIdx: index().on(table.topic),
    timestampIdx: index().on(table.blockTimestamp),
    typeIdx: index().on(table.type),
    utilityIdx: index().on(table.utilityScore),
  })
);

export const message = onchainTable(
  "message",
  (t) => ({
    id: t.text().primaryKey(),
    requestId: t.text().notNull(),
    sourceRequestId: t.text(),
    sourceJobDefinitionId: t.text(),
    to: t.text(),
    content: t.text().notNull(),
    blockTimestamp: t.bigint().notNull(),
  }),
  (table) => ({
    requestIdx: index().on(table.requestId),
    sourceReqIdx: index().on(table.sourceRequestId),
    sourceJobDefIdx: index().on(table.sourceJobDefinitionId),
    toIdx: index().on(table.to),
    ts: index().on(table.blockTimestamp),
  })
);

export const workstream = onchainTable(
  "workstream",
  (t) => ({
    id: t.text().primaryKey(), // workstreamId (same as root request ID)
    rootRequestId: t.text().notNull(),
    jobName: t.text(),
    mech: t.hex().notNull(),
    sender: t.hex().notNull(),
    blockTimestamp: t.bigint().notNull(),
    lastActivity: t.bigint().notNull(),
    childRequestCount: t.integer().notNull(),
    hasLauncherBriefing: t.boolean().notNull(),
    delivered: t.boolean().notNull(),
    lastStatus: t.text(),
    latestStatusUpdate: t.text(),
    ventureId: t.text(),
    templateId: t.text(),
  }),
  (table) => ({
    timestampIdx: index().on(table.blockTimestamp),
    lastActivityIdx: index().on(table.lastActivity),
    lastStatusIdx: index().on(table.lastStatus),
    ventureIdIdx: index().on(table.ventureId),
    mechIdx: index().on(table.mech),
    senderIdx: index().on(table.sender),
  })
);

/**
 * Job Templates - Reusable workflow definitions derived from job definitions
 * 
 * Templates are extracted from job_definition records by grouping similar
 * blueprints and tool configurations. They represent callable workflows
 * that can be executed via x402 payments.
 */
/**
 * Maps service IDs to mech addresses (from CreateMech events)
 * Enables lookup of mech address for a given service ID
 */
export const mechServiceMapping = onchainTable(
  "mech_service_mapping",
  (t) => ({
    id: t.text().primaryKey(), // mech address (lowercase)
    mech: t.hex().notNull(),
    serviceId: t.bigint().notNull(),
    mechFactory: t.hex().notNull(),
    blockTimestamp: t.bigint().notNull(),
  }),
  (table) => ({
    serviceIdIdx: index().on(table.serviceId),
  })
);

/**
 * Tracks staked services by staking contract
 * Enables lookup of all mechs staked in a given staking contract
 */
export const stakedService = onchainTable(
  "staked_service",
  (t) => ({
    id: t.text().primaryKey(), // `${serviceId}:${stakingContract}`
    serviceId: t.bigint().notNull(),
    stakingContract: t.hex().notNull(),
    owner: t.hex().notNull(),
    multisig: t.hex().notNull(),
    stakedAt: t.bigint().notNull(),
    unstakedAt: t.bigint(), // null if still staked
    isStaked: t.boolean().notNull(),
  }),
  (table) => ({
    stakingContractIsStakedIdx: index().on(table.stakingContract, table.isStaked),
    serviceIdIdx: index().on(table.serviceId),
  })
);

export const jobTemplate = onchainTable(
  "job_template",
  (t) => ({
    id: t.text().primaryKey(), // Template ID (slug or UUID)
    name: t.text().notNull(),
    description: t.text(),
    tags: t.text().array(),
    enabledTools: t.text().array(), // Tool policy for this template
    blueprintHash: t.text(), // Hash of canonical blueprint for deduplication
    blueprint: t.text(), // Canonical blueprint JSON
    inputSchema: t.json(), // JSON Schema for template inputs
    outputSpec: t.json(), // OutputSpec for deterministic result extraction
    priceWei: t.bigint(), // x402 price in USDC atomic units (6 decimals, 0 = free)
    priceUsd: t.text(), // Human-readable USD price (e.g., "$0.001")
    canonicalJobDefinitionId: t.text(), // Reference to first/canonical job definition
    runCount: t.integer().notNull(), // Number of times this template has been executed
    successCount: t.integer().notNull(), // Successful completions
    avgDurationSeconds: t.integer(), // Average execution duration
    avgCostWei: t.bigint(), // Average cost from historical runs
    createdAt: t.bigint().notNull(), // First seen timestamp
    lastUsedAt: t.bigint(), // Most recent execution
    status: t.text().notNull(), // 'visible' | 'hidden' | 'deprecated'
    defaultCyclic: t.boolean(), // Template-level default for cyclic mode (auto-restart)
  }),
  (table) => ({
    nameIdx: index().on(table.name),
    statusIdx: index().on(table.status),
    blueprintHashIdx: index().on(table.blueprintHash),
    canonicalJobDefIdx: index().on(table.canonicalJobDefinitionId),
    createdAtIdx: index().on(table.createdAt),
    lastUsedAtIdx: index().on(table.lastUsedAt),
    runCountIdx: index().on(table.runCount),
  })
);
