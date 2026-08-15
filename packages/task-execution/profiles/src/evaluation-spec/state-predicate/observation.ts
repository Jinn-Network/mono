/**
 * This is the shape a probe executor (design §5.1 step 7) and a replayer (§6.4) both emit; the
 * touched-state projection, trace digest, block commitments, and final state commitment exist so
 * K runs can be compared for equality by CE3 — the evaluator does not read them; `stateReads`/
 * `sourceReads` exist so a pure evaluator can resolve state and source predicates at all (finding
 * CE2-F1).
 */
import { z } from "zod";
import {
  AddressSchema,
  Hex32Schema,
  HexSchema,
  UintStringSchema,
} from "./vocabulary.js";

export const CANONICAL_CHAIN_OBSERVATION_VERSION = "1" as const;

const LogObservationSchema = z.strictObject({
  index: UintStringSchema,
  address: AddressSchema,
  topics: z.array(Hex32Schema).max(4),
  data: HexSchema,
});

const TransactionObservationSchema = z.strictObject({
  index: UintStringSchema,
  hash: Hex32Schema,
  from: AddressSchema,
  to: AddressSchema.nullable(),
  valueWei: UintStringSchema,
  status: z.enum(["success", "reverted"]),
  gasUsed: UintStringSchema,
  returnData: HexSchema,
  errorClass: z.string().optional(),
  logs: z.array(LogObservationSchema),
  blockNumber: UintStringSchema,
  blockTimestamp: UintStringSchema,
});

const StateReadObservationSchema = z.strictObject({
  key: z.string().min(1),
  state: z.enum(["baseline", "post-replay"]),
  resolution: z.enum(["resolved", "unavailable"]),
  value: HexSchema.optional(),
});

const SourceReadObservationSchema = z.strictObject({
  key: z.string().min(1),
  resolution: z.enum(["resolved", "miss", "unavailable"]),
  value: z.union([z.string(), z.boolean()]).optional(),
});

export const CanonicalChainObservationSchema = z.strictObject({
  observationVersion: z.literal(CANONICAL_CHAIN_OBSERVATION_VERSION),
  environmentRecord: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  informationWorlds: z.array(z.string()),
  replay: z.strictObject({
    status: z.enum(["completed", "refused", "aborted"]),
    refusalClass: z.string().optional(),
  }),
  timeline: z.strictObject({
    initialBlockNumber: UintStringSchema,
    initialChainTimestamp: UintStringSchema,
    finalStateChangingBlockNumber: UintStringSchema,
    finalStateChangingChainTimestamp: UintStringSchema,
  }),
  transactions: z.array(TransactionObservationSchema),
  blocks: z.array(z.strictObject({ number: UintStringSchema, timestamp: UintStringSchema, hash: Hex32Schema })),
  touchedState: z.array(z.strictObject({
    address: AddressSchema,
    nativeBalanceWei: UintStringSchema,
    nonce: UintStringSchema,
    codeHash: Hex32Schema,
    storage: z.array(z.strictObject({ slot: Hex32Schema, value: Hex32Schema })),
  })),
  traceProjectionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  finalStateCommitment: Hex32Schema,
  errorClasses: z.array(z.string()),
  stateReads: z.array(StateReadObservationSchema),
  sourceReads: z.array(SourceReadObservationSchema),
  sourceConsultations: z.array(z.strictObject({ world: z.string(), requestKey: z.string(), count: UintStringSchema })),
  reports: z.array(z.strictObject({ name: z.string().min(1), value: z.union([z.string(), z.boolean()]) })),
}).superRefine((observation, ctx) => {
  const seenStateReads = new Set<string>();
  observation.stateReads.forEach((read, index) => {
    const identity = `${read.state}${read.key}`;
    if (seenStateReads.has(identity)) {
      ctx.addIssue({
        code: "custom",
        path: ["stateReads", index],
        message: `duplicate state read for key "${read.key}" at ${read.state}.`,
      });
    }
    seenStateReads.add(identity);
    if ((read.resolution === "resolved") !== (read.value !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["stateReads", index, "value"],
        message: "a resolved read carries a value; an unavailable read does not.",
      });
    }
  });

  const seenSourceReads = new Set<string>();
  observation.sourceReads.forEach((read, index) => {
    if (seenSourceReads.has(read.key)) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceReads", index],
        message: `duplicate source read for key "${read.key}".`,
      });
    }
    seenSourceReads.add(read.key);
    if ((read.resolution === "resolved") !== (read.value !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceReads", index, "value"],
        message: "a resolved source read carries a value; miss and unavailable reads do not.",
      });
    }
  });

  const seenReports = new Set<string>();
  observation.reports.forEach((report, index) => {
    if (seenReports.has(report.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["reports", index, "name"],
        message: `duplicate report name "${report.name}".`,
      });
    }
    seenReports.add(report.name);
  });
});
export type CanonicalChainObservation = z.infer<typeof CanonicalChainObservationSchema>;
