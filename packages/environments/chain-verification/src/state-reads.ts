// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, compareCodeUnitStrings, recordDigest } from "@jinn-network/trust-core";
import { z } from "zod";

import { encodeAbiCall } from "./abi-encode.js";
import { invalidInput } from "./errors.js";
import type { StateReadOutcome } from "./observation.js";
import type { RpcTransport } from "./runtime-hosts.js";

const AddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/u, "must be a lowercase 0x address");
const HexBytesSchema = z.string().regex(/^0x(?:[0-9a-f]{2})*$/u, "must be lowercase 0x bytes");

import { AbiValueTypeSchema } from "./abi-encode.js";

export type StructuredReadRequest = {
  readonly to: string;
  readonly signature: string;
  readonly args: readonly string[];
  readonly returns: readonly string[];
  readonly state: "baseline" | "post-replay";
};

export const StructuredReadRequestSchema: z.ZodType<StructuredReadRequest> = z.strictObject({
  to: AddressSchema,
  signature: z.string().regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*\((|[a-z0-9\[\],]+)\)$/u),
  args: z.array(z.string()),
  returns: z.array(AbiValueTypeSchema),
  state: z.enum(["baseline", "post-replay"]),
});

/**
 * Ruling CR6: CE2 emits structured read requests and stays pure; CE3 turns them into calls,
 * because encoding belongs where the call happens and `viem` is banned in the `task-supply`
 * tree a scenario package would otherwise have to encode from.
 *
 * `stateReadKey` is the contract between the two packages: the pure evaluator looks up the
 * projection at the key it derived, so CE3's derivation must be byte-identical to CE2's. It is
 * therefore a pure function of the request, computed over RFC 8785 canonical bytes of a fixed
 * field set, and pinned by a committed corpus both packages assert against.
 */
export function stateReadKey(request: StructuredReadRequest): string {
  const canonical = canonicalJsonBytes({
    to: request.to,
    signature: request.signature,
    args: request.args,
    returns: request.returns,
    state: request.state,
  });
  return recordDigest(canonical);
}

function parseSignatureParams(signature: string): readonly string[] {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open < 0 || close < open) invalidInput(`invalid function signature: ${signature}`);
  const inner = signature.slice(open + 1, close);
  if (inner.length === 0) return [];
  return inner.split(",");
}

function validateRequest(request: StructuredReadRequest): void {
  StructuredReadRequestSchema.parse(request);
  const params = parseSignatureParams(request.signature);
  if (params.length !== request.args.length) {
    invalidInput(
      `signature "${request.signature}" declares ${params.length} parameter(s); ${request.args.length} argument(s) supplied.`,
    );
  }
}

function isRevertData(data: string): boolean {
  return data.startsWith("0x08c379a0");
}

export async function resolveStateReads(
  transport: RpcTransport,
  endpoint: string,
  requests: readonly StructuredReadRequest[],
  options: { readonly state: "baseline" | "post-replay" },
): Promise<readonly StateReadOutcome[]> {
  const outcomes: StateReadOutcome[] = [];
  for (const request of requests) {
    if (request.state !== options.state) continue;
    validateRequest(request);
    const argTypes = parseSignatureParams(request.signature);
    const calldata = encodeAbiCall(request.signature, argTypes, request.args);
    let returnData = "0x";
    let status: StateReadOutcome["status"] = "success";
    try {
      const result = await transport.send({
        endpoint,
        method: "eth_call",
        params: [{ to: request.to, data: calldata }, "latest"],
      });
      if (typeof result !== "string" || !HexBytesSchema.safeParse(result).success) {
        invalidInput("eth_call returned non-hex data");
      }
      returnData = result;
      if (isRevertData(returnData)) status = "reverted";
    } catch (error) {
      const revertData = extractRevertData(error);
      if (revertData === undefined) throw error;
      returnData = revertData;
      status = "reverted";
    }
    outcomes.push({
      key: stateReadKey(request),
      state: request.state,
      to: request.to,
      calldata,
      returnData,
      status,
    });
  }
  return outcomes.sort((left, right) => compareCodeUnitStrings(left.key, right.key));
}

function extractRevertData(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const candidates = [record.data, record.result];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && HexBytesSchema.safeParse(candidate).success) {
      return candidate;
    }
  }
  return undefined;
}
