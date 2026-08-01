/**
 * Fixture-address convention (program §4.8): every address in this family's tests and fixtures
 * is a synthetic documentation address of the form `0x` + a repeated nibble or a `0x0000…00NN`
 * counter — never a well-known dev-mnemonic address someone might fund.
 */
import { z } from "zod";
import { ResourceDescriptorSchema } from "../../resource-descriptor.js";
import { COMPARISON_OPS, DECIMAL_STRING_PATTERN } from "../verdict-rule.js";
import type { ComparisonOp } from "../verdict-rule.js";

/**
 * The evaluation semantics version of THIS family's predicate vocabulary — distinct from the
 * spec-wide `EVAL_SEMANTICS_VERSION` seed, which is unchanged by an additive family. A block
 * declaring an unknown version fails closed rather than being graded by an evaluator that does
 * not implement its rules.
 */
export const PREDICATE_SEMANTICS_VERSION = "1" as const;

/**
 * The composite kind a task's EvaluationSpec references (chain design §4.1/§6.1, E11). The
 * constant is OWNED by `@jinn-network/chain-environment-record` (CE1); profiles imports
 * `@jinn-network/task-execution-protocol` only, so the literal is restated here and held equal
 * by CE5's cross-package fixture — the same posture this package takes for sealing.
 */
export const CRYPTO_ENVIRONMENT_MEDIA_TYPE = "application/vnd.jinn.crypto-environment.v1+json" as const;

// Lowercase-only hex: rejection, never normalization — a read key is a pure concatenation of
// these strings, so two spellings of one address must not produce two keys.
export const AddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/, "address must be lowercase 0x-hex (20 bytes)");
export const HexSchema = z.string().regex(/^0x(?:[0-9a-f]{2})*$/, "must be lowercase 0x-hex with whole bytes");
export const Hex32Schema = z.string().regex(/^0x[0-9a-f]{64}$/, "must be a lowercase 0x-hex 32-byte word");
/** A non-negative integer as a decimal string — wei and gas exceed I-JSON's safe-integer range. */
export const UintStringSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/, "must be a non-negative decimal string");
export const DecimalStringSchema = z.string().regex(DECIMAL_STRING_PATTERN, "must be a decimal string");

/** Comparators (design §6.2): the six ordered/equality ops plus the two tolerance forms. */
export const PREDICATE_COMPARATORS = [...COMPARISON_OPS, "within-abs", "within-rel"] as const;
export type PredicateComparator = (typeof PREDICATE_COMPARATORS)[number];
export const TOLERANCE_COMPARATORS = ["within-abs", "within-rel"] as const;
export const ORDERED_COMPARATORS = ["lt", "lte", "gt", "gte", "within-abs", "within-rel"] as const;

const NUMERIC_COMPARISON_SHAPE = {
  cmp: z.enum(PREDICATE_COMPARATORS),
  value: DecimalStringSchema,
  tolerance: DecimalStringSchema.optional(),
} as const;

const CountCmpSchema = z.strictObject({
  cmp: z.enum(COMPARISON_OPS),
  value: UintStringSchema,
});

const DecodeSchema = z.enum(["raw", "uint256", "int256"]);

type DecodeField = z.infer<typeof DecodeSchema>;

/** `tolerance` is required by `within-*` and forbidden otherwise — a tolerance an author
 * believes is applied but which the comparator ignores is a silent grading error. */
function refineTolerance<T extends z.ZodTypeAny>(schema: T): T {
  return schema.superRefine((predicate, ctx) => {
    const { cmp, tolerance } = predicate as { cmp: PredicateComparator; tolerance?: string };
    const needsTolerance = (TOLERANCE_COMPARATORS as readonly string[]).includes(cmp);
    if (needsTolerance && tolerance === undefined) {
      ctx.addIssue({ code: "custom", path: ["tolerance"], message: `Comparator "${cmp}" requires a tolerance.` });
    }
    if (!needsTolerance && tolerance !== undefined) {
      ctx.addIssue({ code: "custom", path: ["tolerance"], message: `Comparator "${cmp}" must not carry a tolerance.` });
    }
  }) as unknown as T;
}

function refineDecodeCmpValue<T extends z.ZodTypeAny>(
  schema: T,
  cmpValues: readonly ComparisonOp[] | readonly PredicateComparator[],
): T {
  return schema.superRefine((obj, ctx) => {
    const { decode, cmp, value } = obj as {
      decode: DecodeField;
      cmp: ComparisonOp | PredicateComparator;
      value: string;
    };
    if (decode === "raw") {
      if (cmp !== "eq" && cmp !== "ne") {
        ctx.addIssue({
          code: "custom",
          path: ["cmp"],
          message: `decode "raw" admits only eq/ne comparators; got "${cmp}".`,
        });
      }
      if (!HexSchema.safeParse(value).success) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: `decode "raw" requires a hex value.`,
        });
      }
    } else if (!DecimalStringSchema.safeParse(value).success) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `decode "${decode}" requires a decimal string value.`,
      });
    }
    void cmpValues;
  }) as unknown as T;
}

/**
 * A read call, declared either as calldata the author already had, or declaratively. CE2 never
 * turns the declarative form into bytes: `stateReadRequests` passes the abi reference, the
 * function signature, and the typed arguments through to the observation producer (CE3's probe
 * executor / replayer), which is where an encoder may sit behind the runtime port and where the
 * RPC call is made anyway. This module stays free of every chain library — the property Task 7
 * asserts mechanically — while the scenario layer, which has no encoder available to it at all,
 * can still express a read whose arguments are only known at parameterization time.
 */
const AbiArgSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("address"), value: AddressSchema }),
  z.strictObject({ type: z.literal("bool"), value: z.boolean() }),
  z.strictObject({ type: z.literal("bytes"), value: HexSchema }),
  z.strictObject({ type: z.literal("bytes32"), value: Hex32Schema }),
  z.strictObject({ type: z.literal("int256"), value: DecimalStringSchema }),
  z.strictObject({ type: z.literal("string"), value: z.string() }),
  z.strictObject({ type: z.literal("uint256"), value: UintStringSchema }),
  // Single-dimension arrays of the same closed scalar set. Nested tuples and multi-dimensional
  // arrays are outside v1: a template that needs one is a gap to widen deliberately (report it),
  // not a shape to approximate here.
  z.strictObject({ type: z.literal("address[]"), values: z.array(AddressSchema) }),
  z.strictObject({ type: z.literal("bytes32[]"), values: z.array(Hex32Schema) }),
  z.strictObject({ type: z.literal("uint256[]"), values: z.array(UintStringSchema) }),
]);
export type AbiArg = z.infer<typeof AbiArgSchema>;

export const CallTargetSchema = z.union([
  z.strictObject({ encodedCall: HexSchema }),
  z.strictObject({
    // Which ABI the author read this function out of — digest authoritative, bare-hex DigestSet,
    // never inlined. Same descriptor discipline as `environmentRecord`.
    abiRef: ResourceDescriptorSchema,
    // The canonical Solidity signature, e.g. "balanceOf(address)" — no spaces, no parameter
    // names, no return clause. Rejected otherwise, so the producer's selector derivation and
    // this module's key derivation cannot disagree about what the author meant.
    function: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*\((?:[A-Za-z0-9\[\]]+(?:,[A-Za-z0-9\[\]]+)*)?\)$/),
    args: z.array(AbiArgSchema),
  }),
]).superRefine((target, ctx) => {
  if ("encodedCall" in target) return;
  const declared = target.function.slice(target.function.indexOf("(") + 1, -1);
  const types = declared === "" ? [] : declared.split(",");
  if (types.length !== target.args.length) {
    ctx.addIssue({ code: "custom", path: ["args"], message: `function "${target.function}" declares ${types.length} parameter(s); ${target.args.length} argument(s) supplied.` });
  }
  types.forEach((type, index) => {
    const arg = target.args[index];
    if (arg !== undefined && arg.type !== type) {
      ctx.addIssue({ code: "custom", path: ["args", index, "type"], message: `argument ${index} is "${arg.type}" but the signature declares "${type}".` });
    }
  });
});
export type CallTarget = z.infer<typeof CallTargetSchema>;

const ArgFilterSchema = z.discriminatedUnion("on", [
  z.strictObject({
    on: z.literal("topic"),
    index: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    equals: Hex32Schema,
  }),
  refineDecodeCmpValue(
    z.strictObject({
      on: z.literal("dataWord"),
      index: UintStringSchema,
      decode: DecodeSchema,
      cmp: z.enum(COMPARISON_OPS),
      value: z.string(),
    }),
    COMPARISON_OPS,
  ),
]);

function refineEventMatcher<T extends z.ZodTypeAny>(schema: T): T {
  return schema.superRefine((matcher, ctx) => {
    const { topic0, signature } = matcher as { topic0?: string; signature?: string };
    const hasTopic = topic0 !== undefined;
    const hasSignature = signature !== undefined;
    if (hasTopic && hasSignature) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of topic0 or signature must be present, not both.",
      });
    }
    if (!hasTopic && !hasSignature) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of topic0 or signature is required.",
      });
    }
  }) as unknown as T;
}

const EventMatcherFields = {
  source: AddressSchema.optional(),
  topic0: Hex32Schema.optional(),
  signature: z.string().optional(),
  argFilters: z.array(ArgFilterSchema).optional(),
} as const;

const GroundTruthSchema = z.strictObject({
  to: AddressSchema,
  call: CallTargetSchema,
  decode: DecodeSchema,
});

const NativeBalancePredicateSchema = refineTolerance(
  z.strictObject({
    kind: z.literal("nativeBalance"),
    label: z.string().optional(),
    account: AddressSchema,
    ...NUMERIC_COMPARISON_SHAPE,
  }),
);

const Erc20BalancePredicateSchema = refineTolerance(
  z.strictObject({
    kind: z.literal("erc20Balance"),
    label: z.string().optional(),
    token: AddressSchema,
    account: AddressSchema,
    ...NUMERIC_COMPARISON_SHAPE,
  }),
);

const CallResultPredicateSchema = refineTolerance(
  refineDecodeCmpValue(
    z.strictObject({
      kind: z.literal("callResult"),
      label: z.string().optional(),
      to: AddressSchema,
      call: CallTargetSchema,
      decode: DecodeSchema,
      cmp: z.enum(PREDICATE_COMPARATORS),
      value: z.string(),
      tolerance: DecimalStringSchema.optional(),
    }),
    PREDICATE_COMPARATORS,
  ),
);

const StorageValuePredicateSchema = refineTolerance(
  refineDecodeCmpValue(
    z.strictObject({
      kind: z.literal("storageValue"),
      label: z.string().optional(),
      address: AddressSchema,
      slot: Hex32Schema,
      decode: DecodeSchema,
      cmp: z.enum(PREDICATE_COMPARATORS),
      value: z.string(),
      tolerance: DecimalStringSchema.optional(),
    }),
    PREDICATE_COMPARATORS,
  ),
);

const EventEmittedPredicateSchema = refineEventMatcher(
  z.strictObject({
    kind: z.literal("eventEmitted"),
    label: z.string().optional(),
    ...EventMatcherFields,
    countCmp: CountCmpSchema,
  }),
);

const EventForbiddenPredicateSchema = refineEventMatcher(
  z.strictObject({
    kind: z.literal("eventForbidden"),
    label: z.string().optional(),
    ...EventMatcherFields,
  }),
);

const TxOutcomePredicateSchema = z.strictObject({
  kind: z.literal("txOutcome"),
  label: z.string().optional(),
  selector: z.union([
    z.strictObject({ all: z.literal(true) }),
    z.strictObject({ index: UintStringSchema }),
  ]),
  status: z.enum(["success", "reverted"]),
});

const ApprovalConstraintPredicateSchema = z.strictObject({
  kind: z.literal("approvalConstraint"),
  label: z.string().optional(),
  token: AddressSchema.optional(),
  owner: AddressSchema.optional(),
  noUnlimited: z.boolean(),
  allowedSpenders: z.array(AddressSchema).optional(),
  maxAllowance: UintStringSchema.optional(),
});

const AddressForbiddenPredicateSchema = z.strictObject({
  kind: z.literal("addressForbidden"),
  label: z.string().optional(),
  targets: z.array(AddressSchema).min(1),
});

const BudgetPredicateSchema = z.strictObject({
  kind: z.literal("budget"),
  label: z.string().optional(),
  metric: z.enum(["gasTotal", "txCount", "valueOutWei"]),
  cmp: z.enum(COMPARISON_OPS),
  value: UintStringSchema,
});

const ReportedValuePredicateSchema = refineTolerance(
  z.strictObject({
    kind: z.literal("reportedValue"),
    label: z.string().optional(),
    name: z.string().min(1),
    cmp: z.enum(PREDICATE_COMPARATORS),
    value: DecimalStringSchema,
    tolerance: DecimalStringSchema.optional(),
    groundTruth: GroundTruthSchema,
    groundTruthState: z.enum(["baseline", "post-replay"]).optional(),
  }),
);

const TimeBoundPredicateSchema = z.strictObject({
  kind: z.literal("timeBound"),
  label: z.string().optional(),
  metric: z.enum(["completedWithinBlocks", "completedWithinChainSeconds"]),
  maximum: UintStringSchema,
});

const SourceValuePredicateSchema = refineTolerance(
  z.strictObject({
    kind: z.literal("sourceValue"),
    label: z.string().optional(),
    world: z.string(),
    requestKey: z.string(),
    selector: z.string(),
    cmp: z.enum(PREDICATE_COMPARATORS),
    value: z.union([z.string(), z.boolean()]),
    tolerance: DecimalStringSchema.optional(),
  }),
);

export const SourceConsultedPredicateSchema = z.strictObject({
  kind: z.literal("sourceConsulted"),
  label: z.string().optional(),
  world: z.string(),
  requestKey: z.string(),
  countCmp: CountCmpSchema.optional(),
});

export const EventCountObservationSchema = refineEventMatcher(
  z.strictObject({
    kind: z.literal("eventEmitted"),
    ...EventMatcherFields,
  }),
);

export const PredicateSchema = z.discriminatedUnion("kind", [
  AddressForbiddenPredicateSchema,
  ApprovalConstraintPredicateSchema,
  BudgetPredicateSchema,
  CallResultPredicateSchema,
  Erc20BalancePredicateSchema,
  EventEmittedPredicateSchema,
  EventForbiddenPredicateSchema,
  NativeBalancePredicateSchema,
  ReportedValuePredicateSchema,
  SourceConsultedPredicateSchema,
  SourceValuePredicateSchema,
  StorageValuePredicateSchema,
  TimeBoundPredicateSchema,
  TxOutcomePredicateSchema,
]);
export type Predicate = z.infer<typeof PredicateSchema>;

export const PREDICATE_KINDS = [
  "addressForbidden", "approvalConstraint", "budget", "callResult", "erc20Balance",
  "eventEmitted", "eventForbidden", "nativeBalance", "reportedValue", "sourceConsulted",
  "sourceValue", "storageValue", "timeBound", "txOutcome",
] as const;
export type PredicateKind = (typeof PREDICATE_KINDS)[number];

/** Design §6.2: `safetyConstraints` evaluate over the replay's transaction/receipt/log record,
 * so in v1 "throughout" is bounded to log- and transaction-observable kinds. A STATE predicate
 * used as a safety constraint is a validation error, not a best-effort check — per-operation
 * state snapshots are a parked extension. */
export const SAFETY_CONSTRAINT_KINDS = [
  "addressForbidden", "approvalConstraint", "budget", "eventForbidden", "txOutcome",
] as const;

/** `sourceConsulted` records what the agent read; it never gates (design §6.2, finding CE2-F4). */
export const MEASUREMENT_ONLY_KINDS = ["sourceConsulted"] as const;

export const SUCCESS_PREDICATE_KINDS = PREDICATE_KINDS
  .filter((kind) => !(MEASUREMENT_ONLY_KINDS as readonly string[]).includes(kind));

export const MeasurementObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("gasTotal") }),
  z.strictObject({ kind: z.literal("txCount") }),
  z.strictObject({ kind: z.literal("valueOutWei") }),
  z.strictObject({ kind: z.literal("blocksElapsed") }),
  z.strictObject({ kind: z.literal("chainSecondsElapsed") }),
  z.strictObject({ kind: z.literal("reportedValue"), name: z.string().min(1) }),
  EventCountObservationSchema,
  SourceConsultedPredicateSchema,
]);

export const StatePredicateMeasurementSchema = z.strictObject({
  name: z.string().min(1),
  observe: MeasurementObservationSchema,
});

/** Tighten-only restrictions on the record's envelope (design §6.1). profiles validates SHAPE
 * only: the tighten-only COMPARISON needs the environment record's envelope, which is never
 * inlined here (E11) — CE3/CE5 perform it against the resolved record. */
export const EnvelopeTighteningsSchema = z.strictObject({
  maxTransactions: UintStringSchema.optional(),
  maxAggregateNativeValueWei: UintStringSchema.optional(),
  maxGasTotal: UintStringSchema.optional(),
  maxBlocksAdvanced: UintStringSchema.optional(),
  maxChainSecondsAdvanced: UintStringSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, "envelopeTightenings must tighten something");

/** The composite crypto-environment record, by digest. No environment content is inlined
 * (E11) — `content` is rejected outright. `digest.sha256` is an in-toto DigestSet value:
 * BARE lowercase hex, never `sha256:`-prefixed (program §4.6). */
export const EnvironmentRecordDescriptorSchema = ResourceDescriptorSchema.superRefine((descriptor, ctx) => {
  if (descriptor.content !== undefined) {
    ctx.addIssue({ code: "custom", path: ["content"], message: "environmentRecord must be referenced by digest; no environment content is inlined (E11)." });
  }
  const sha256 = descriptor.digest?.["sha256"];
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    ctx.addIssue({ code: "custom", path: ["digest", "sha256"], message: "environmentRecord requires digest.sha256 as bare lowercase hex (in-toto DigestSet)." });
  }
  if (descriptor.mediaType !== CRYPTO_ENVIRONMENT_MEDIA_TYPE) {
    ctx.addIssue({ code: "custom", path: ["mediaType"], message: `environmentRecord must reference the composite crypto-environment record (${CRYPTO_ENVIRONMENT_MEDIA_TYPE}).` });
  }
});
