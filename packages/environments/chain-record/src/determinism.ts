import { z } from "zod";

import { Address, Bytes32, Count, Quantity } from "./primitives.js";

/**
 * `manual` mints a block only when an operation asks for one; `auto` mints one per
 * transaction. Both are driven by the agent and the sealed fixtures, which is what E8's paused
 * world means. Interval mining is absent from the vocabulary rather than merely discouraged:
 * it produces blocks on the host's wall clock, so two runs of one script would see different
 * block counts and different timestamps.
 */
export const MINING_MODES = Object.freeze(["manual", "auto"] as const);

export const ORDERING_POLICIES = Object.freeze(["fifo", "fees"] as const);
export const MEMPOOL_POLICIES = Object.freeze(["none", "queued"] as const);
export const REPLACEMENT_POLICIES = Object.freeze(["reject", "replace-by-fee"] as const);
export const NONCE_POLICIES = Object.freeze(["strict", "permissive"] as const);
export const TIMEOUT_CLOCKS = Object.freeze(["wall-clock", "chain-time"] as const);

/**
 * `fresh-process` launches a new process with a clean copy of the state artifact.
 * `snapshot-revert` rewinds inside one process — a testing convenience the record may declare,
 * but §5.1 step 8 forbids it as the reset mechanism of a closed-state world, because it cannot
 * catch startup, artifact-load, cache, or process-global drift. That coupling is enforced at
 * record level, not here, so this schema stays usable on its own.
 */
export const RESET_MECHANISMS = Object.freeze(["fresh-process", "snapshot-revert"] as const);

const BlockTimeProgressionSchema = z
  .strictObject({
    mode: z.enum(["fixed-increment", "none"]),
    secondsPerBlock: Count.optional(),
  })
  .superRefine((progression, ctx) => {
    if (progression.mode === "fixed-increment" && progression.secondsPerBlock === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["secondsPerBlock"],
        message: "a fixed-increment progression must declare secondsPerBlock",
      });
    }
    if (progression.mode === "none" && progression.secondsPerBlock !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["secondsPerBlock"],
        message: "a `none` progression advances no time and must not declare secondsPerBlock",
      });
    }
  });

const feePolicy = (disabledMode: "disabled" | "zero") =>
  z
    .strictObject({
      mode: z.enum(["fixed", disabledMode]),
      weiPerGas: Quantity.optional(),
    })
    .superRefine((policy, ctx) => {
      if (policy.mode === "fixed" && policy.weiPerGas === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["weiPerGas"],
          message: "a fixed fee policy must declare weiPerGas",
        });
      }
      if (policy.mode !== "fixed" && policy.weiPerGas !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["weiPerGas"],
          message: `a ${policy.mode} fee policy charges nothing and must not declare weiPerGas`,
        });
      }
    });

/**
 * Every outcome-affecting knob §4.3 enumerates, each one required. An omitted knob is exactly
 * the knob whose runtime default moved between two patch versions, so presence is the first
 * rule here and values are the second.
 *
 * The bounds in `timeWarp` are load-bearing beyond reproducibility: §6.2 names time advancement
 * as the most common way a balance-only success predicate is satisfied without the intended
 * action, since accrual, timelocks, and time-dependent oracles all move with it.
 */
export const DeterminismControlsSchema = z.strictObject({
  miningMode: z.enum(MINING_MODES),
  orderingPolicy: z.enum(ORDERING_POLICIES),
  mempoolPolicy: z.enum(MEMPOOL_POLICIES),
  initialBlockNumber: Count,
  /** Unix seconds of the initial block. */
  initialTimestamp: Count,
  blockTimeProgression: BlockTimeProgressionSchema,
  baseFeePolicy: feePolicy("disabled"),
  gasPricePolicy: feePolicy("zero"),
  blockGasLimit: Quantity,
  perTransactionGasCeiling: Quantity,
  coinbase: Address,
  prevrandao: Bytes32,
  replacementPolicy: z.enum(REPLACEMENT_POLICIES),
  noncePolicy: z.enum(NONCE_POLICIES),
  timeoutClock: z.enum(TIMEOUT_CLOCKS),
  timeWarp: z.strictObject({
    maxSecondsPerOperation: Count,
    maxAggregateSeconds: Count,
    maxBlocksPerOperation: Count,
  }),
  resetMechanism: z.enum(RESET_MECHANISMS),
});

export type DeterminismControls = z.infer<typeof DeterminismControlsSchema>;
