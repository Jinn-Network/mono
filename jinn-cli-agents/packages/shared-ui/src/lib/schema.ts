import { pgTable, text, bigint, boolean, integer, index } from "drizzle-orm/pg-core";

export const jobDefinition = pgTable(
  "job_definition",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    enabledTools: text("enabled_tools").array(),
    blueprint: text("blueprint"),
    workstreamId: text("workstream_id"),
    sourceJobDefinitionId: text("source_job_definition_id"),
    sourceRequestId: text("source_request_id"),
    codeMetadata: text("code_metadata"),
    createdAt: bigint("created_at", { mode: "bigint" }),
    lastInteraction: bigint("last_interaction", { mode: "bigint" }),
    lastStatus: text("last_status"),
  },
  (table) => ({
    nameIdx: index("name_idx").on(table.name),
    workstreamIdIdx: index("workstream_id_idx").on(table.workstreamId),
    sourceJobDefIdx: index("source_job_def_idx").on(table.sourceJobDefinitionId),
    sourceReqIdx: index("source_req_idx").on(table.sourceRequestId),
    lastInteractionIdx: index("last_interaction_idx").on(table.lastInteraction),
  })
);

export const request = pgTable(
  "request",
  {
    id: text("id").primaryKey(),
    mech: text("mech").notNull(),
    sender: text("sender").notNull(),
    workstreamId: text("workstream_id"),
    jobDefinitionId: text("job_definition_id"),
    sourceRequestId: text("source_request_id"),
    sourceJobDefinitionId: text("source_job_definition_id"),
    requestData: text("request_data"),
    ipfsHash: text("ipfs_hash"),
    deliveryIpfsHash: text("delivery_ipfs_hash"),
    transactionHash: text("transaction_hash"),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    blockTimestamp: bigint("block_timestamp", { mode: "bigint" }).notNull(),
    delivered: boolean("delivered").notNull(),
    jobName: text("job_name"),
    enabledTools: text("enabled_tools").array(),
    additionalContext: text("additional_context"),
    dependencies: text("dependencies").array(),
  },
  (table) => ({
    ts: index("ts").on(table.blockTimestamp),
    mechIdx: index("mech_idx").on(table.mech),
    senderIdx: index("sender_idx").on(table.sender),
    workstreamIdIdx: index("workstream_id_idx_request").on(table.workstreamId),
    jobDefIdx: index("job_def_idx").on(table.jobDefinitionId),
    sourceReqIdx: index("source_req_idx_request").on(table.sourceRequestId),
    sourceJobDefIdx: index("source_job_def_idx_request").on(table.sourceJobDefinitionId),
  })
);

export const delivery = pgTable(
  "delivery",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    sourceRequestId: text("source_request_id"),
    sourceJobDefinitionId: text("source_job_definition_id"),
    mech: text("mech").notNull(),
    mechServiceMultisig: text("mech_service_multisig").notNull(),
    deliveryRate: bigint("delivery_rate", { mode: "bigint" }).notNull(),
    ipfsHash: text("ipfs_hash"),
    transactionHash: text("transaction_hash").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    blockTimestamp: bigint("block_timestamp", { mode: "bigint" }).notNull(),
  },
  (table) => ({
    ts: index("ts_delivery").on(table.blockTimestamp),
    mechIdx: index("mech_idx_delivery").on(table.mech),
    requestIdIdx: index("request_id_idx").on(table.requestId),
    sourceReqIdx: index("source_req_idx_delivery").on(table.sourceRequestId),
    sourceJobDefIdx: index("source_job_def_idx_delivery").on(table.sourceJobDefinitionId),
  })
);

export const artifact = pgTable(
  "artifact",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    sourceRequestId: text("source_request_id"),
    sourceJobDefinitionId: text("source_job_definition_id"),
    name: text("name").notNull(),
    cid: text("cid").notNull(),
    topic: text("topic").notNull(),
    contentPreview: text("content_preview"),
    blockTimestamp: bigint("block_timestamp", { mode: "bigint" }).notNull(),
    type: text("type"),
    tags: text("tags").array(),
    utilityScore: integer("utility_score"),
    accessCount: integer("access_count"),
  },
  (table) => ({
    requestIdIdx: index("request_id_idx_artifact").on(table.requestId),
    sourceReqIdx: index("source_req_idx_artifact").on(table.sourceRequestId),
    sourceJobDefIdx: index("source_job_def_idx_artifact").on(table.sourceJobDefinitionId),
    topicIdx: index("topic_idx").on(table.topic),
    timestampIdx: index("timestamp_idx").on(table.blockTimestamp),
    typeIdx: index("type_idx").on(table.type),
    utilityIdx: index("utility_idx").on(table.utilityScore),
  })
);

export const message = pgTable(
  "message",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    sourceRequestId: text("source_request_id"),
    sourceJobDefinitionId: text("source_job_definition_id"),
    to: text("to"),
    content: text("content").notNull(),
    blockTimestamp: bigint("block_timestamp", { mode: "bigint" }).notNull(),
  },
  (table) => ({
    requestIdx: index("request_idx").on(table.requestId),
    sourceReqIdx: index("source_req_idx_message").on(table.sourceRequestId),
    sourceJobDefIdx: index("source_job_def_idx_message").on(table.sourceJobDefinitionId),
    toIdx: index("to_idx").on(table.to),
    ts: index("ts_message").on(table.blockTimestamp),
  })
);

// Job template table (for services)
export const jobTemplate = pgTable(
  "job_template",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    description: text("description"),
    tags: text("tags").array(),
    enabledTools: text("enabled_tools").array(),
    blueprintHash: text("blueprint_hash"),
    blueprint: text("blueprint"),
    inputSchema: text("input_schema"),
    outputSpec: text("output_spec"),
    priceWei: bigint("price_wei", { mode: "bigint" }),
    priceUsd: text("price_usd"),
    canonicalJobDefinitionId: text("canonical_job_definition_id"),
    runCount: integer("run_count"),
    successCount: integer("success_count"),
    avgDurationSeconds: integer("avg_duration_seconds"),
    avgCostWei: bigint("avg_cost_wei", { mode: "bigint" }),
    createdAt: bigint("created_at", { mode: "bigint" }),
    lastUsedAt: bigint("last_used_at", { mode: "bigint" }),
    status: text("status"),
    defaultCyclic: boolean("default_cyclic"),
  },
  (table) => ({
    nameIdx: index("job_template_name_idx").on(table.name),
    statusIdx: index("job_template_status_idx").on(table.status),
    blueprintHashIdx: index("job_template_blueprint_hash_idx").on(table.blueprintHash),
    createdAtIdx: index("job_template_created_at_idx").on(table.createdAt),
    lastUsedAtIdx: index("job_template_last_used_at_idx").on(table.lastUsedAt),
  })
);

// Workstream table (for service instances)
export const workstream = pgTable(
  "workstream",
  {
    id: text("id").primaryKey(),
    rootRequestId: text("root_request_id"),
    jobName: text("job_name"),
    mech: text("mech"),
    sender: text("sender"),
    blockTimestamp: bigint("block_timestamp", { mode: "bigint" }),
    lastActivity: bigint("last_activity", { mode: "bigint" }),
    childRequestCount: integer("child_request_count"),
    hasLauncherBriefing: boolean("has_launcher_briefing"),
    delivered: boolean("delivered"),
  },
  (table) => ({
    blockTimestampIdx: index("workstream_block_timestamp_idx").on(table.blockTimestamp),
    lastActivityIdx: index("workstream_last_activity_idx").on(table.lastActivity),
    mechIdx: index("workstream_mech_idx").on(table.mech),
    senderIdx: index("workstream_sender_idx").on(table.sender),
  })
);
