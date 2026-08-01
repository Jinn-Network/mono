import { z } from "zod";

import { Count, NonEmpty, PrefixedSha256 } from "./primitives.js";
import { parseExactWithSchema, sealWithSchema } from "./sealing.js";

/** §14's naming pass. The script is the deliverable; the trajectory is evidence beside it. */
export const CHAIN_SOLUTION_MEDIA_TYPE = "application/vnd.jinn.chain-solution.v1+json" as const;

export const SOLUTION_OPERATION_KINDS = Object.freeze([
  "signedTransaction",
  "timeWarp",
  "mine",
  "report",
] as const);

/**
 * The closed operation vocabulary (§6.4). A transaction arrives as raw **signed** bytes, not as
 * a request the replayer would have to sign — the replayer holds no keys, and a script that
 * asked it to sign would be asking for ambient authority.
 */
const SolutionOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("signedTransaction"),
    rawTransaction: z.string().regex(/^0x[0-9a-fA-F]+$/, "expected 0x-prefixed raw transaction bytes"),
  }),
  z.strictObject({ kind: z.literal("timeWarp"), seconds: Count }),
  z.strictObject({ kind: z.literal("mine"), blocks: Count }),
  /** A value the agent asserts, graded against ground truth computed from the frozen state. */
  z.strictObject({ kind: z.literal("report"), name: NonEmpty, value: z.string() }),
]);

export type ChainSolutionOperation = z.infer<typeof SolutionOperationSchema>;

/**
 * An ordered, replay-order-stable script, bound by digest to the environment it replays against.
 *
 * Bounded claim, stated once and meant literally: replaying this script on a fresh instance of
 * that environment is what the verdict grades. Nothing here binds the script to the trajectory
 * that produced it — that correspondence is a declared trust step (§6.4), and a harness
 * attestation closing it is parked as an extension.
 *
 * An empty operation list is the do-nothing script admission executes to prove the task demands
 * action, so emptiness is legal and load-bearing.
 */
export const ChainSolutionScriptSchema = z.strictObject({
  mediaType: z.literal(CHAIN_SOLUTION_MEDIA_TYPE),
  environmentRecordDigest: PrefixedSha256,
  operations: z.array(SolutionOperationSchema),
});

export type ChainSolutionScript = z.infer<typeof ChainSolutionScriptSchema>;

export function sealChainSolutionScript(script: unknown): Uint8Array {
  return sealWithSchema(ChainSolutionScriptSchema, script);
}

export function parseChainSolutionScript(bytes: Uint8Array): ChainSolutionScript {
  return parseExactWithSchema(ChainSolutionScriptSchema, bytes);
}
