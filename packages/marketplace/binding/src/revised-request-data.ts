// SPDX-License-Identifier: MIT

import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  toBytes,
} from "viem";

export const REVISED_REQUEST_DATA_DOMAIN = "jinn.marketplace.revised" as const;
export const REVISED_REQUEST_DATA_VERSION = 2 as const;
export const REVISED_LEG_SOLUTION = 1 as const;
export const REVISED_LEG_VERDICT = 2 as const;
export const REVISED_SOLUTION_VERDICT_SENTINEL = 0 as const;
export const REVISED_SOLUTION_VERDICT_CODE_SENTINEL = 0 as const;
export const REVISED_DOMAIN_HASH = keccak256(toBytes(REVISED_REQUEST_DATA_DOMAIN));

export type RevisedRequestData = {
  readonly domain: `0x${string}`;
  readonly version: number;
  readonly legKind: typeof REVISED_LEG_SOLUTION | typeof REVISED_LEG_VERDICT;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly verdictIndex: number;
  readonly deliveryDigest: `0x${string}`;
  readonly verdictCode: number;
};

const REQUEST_DATA_ABI = parseAbiParameters(
  "bytes32 domain, uint8 version, uint8 legKind, uint256 taskId, uint32 attemptIndex, uint32 verdictIndex, bytes32 deliveryDigest, uint8 verdictCode",
);

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as const;

export function encodeRevisedRequestData(input: {
  readonly legKind: RevisedRequestData["legKind"];
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly verdictIndex: number;
  readonly deliveryDigest: `0x${string}`;
  readonly verdictCode: number;
}): `0x${string}` {
  const decoded: RevisedRequestData = {
    domain: REVISED_DOMAIN_HASH,
    version: REVISED_REQUEST_DATA_VERSION,
    ...input,
  };
  assertRevisedRequestDataShape(decoded);
  return encodeAbiParameters(REQUEST_DATA_ABI, [
    decoded.domain,
    decoded.version,
    decoded.legKind,
    decoded.taskId,
    decoded.attemptIndex,
    decoded.verdictIndex,
    decoded.deliveryDigest,
    decoded.verdictCode,
  ]);
}

export function encodeRevisedSolutionRequestData(input: {
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly deliveryDigest: `0x${string}`;
}): `0x${string}` {
  return encodeRevisedRequestData({
    legKind: REVISED_LEG_SOLUTION,
    taskId: input.taskId,
    attemptIndex: input.attemptIndex,
    verdictIndex: REVISED_SOLUTION_VERDICT_SENTINEL,
    deliveryDigest: input.deliveryDigest,
    verdictCode: REVISED_SOLUTION_VERDICT_CODE_SENTINEL,
  });
}

export function encodeRevisedVerdictRequestData(input: {
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly verdictIndex: number;
  readonly deliveryDigest: `0x${string}`;
  readonly verdictCode: number;
}): `0x${string}` {
  return encodeRevisedRequestData({
    legKind: REVISED_LEG_VERDICT,
    ...input,
  });
}

export function decodeRevisedRequestData(data: `0x${string}`): RevisedRequestData {
  const [
    domain,
    version,
    legKind,
    taskId,
    attemptIndex,
    verdictIndex,
    deliveryDigest,
    verdictCode,
  ] = decodeAbiParameters(REQUEST_DATA_ABI, data);
  const decoded: RevisedRequestData = {
    domain,
    version: Number(version),
    legKind: Number(legKind) as RevisedRequestData["legKind"],
    taskId,
    attemptIndex: Number(attemptIndex),
    verdictIndex: Number(verdictIndex),
    deliveryDigest,
    verdictCode: Number(verdictCode),
  };
  assertRevisedRequestDataShape(decoded);
  return decoded;
}

export function assertRevisedRequestDataShape(
  decoded: RevisedRequestData,
): void {
  if (decoded.domain !== REVISED_DOMAIN_HASH) {
    throw new Error(`revised requestData domain mismatch: ${decoded.domain}`);
  }
  if (decoded.version !== REVISED_REQUEST_DATA_VERSION) {
    throw new Error(`revised requestData version mismatch: ${decoded.version}`);
  }
  if (
    decoded.legKind !== REVISED_LEG_SOLUTION
    && decoded.legKind !== REVISED_LEG_VERDICT
  ) {
    throw new Error(`revised requestData legKind invalid: ${decoded.legKind}`);
  }
  if (decoded.legKind === REVISED_LEG_SOLUTION) {
    if (decoded.verdictIndex !== REVISED_SOLUTION_VERDICT_SENTINEL) {
      throw new Error("solution requestData must use verdictIndex sentinel 0");
    }
    if (decoded.verdictCode !== REVISED_SOLUTION_VERDICT_CODE_SENTINEL) {
      throw new Error("solution requestData must use verdictCode sentinel 0");
    }
  } else if (decoded.verdictCode < 1 || decoded.verdictCode > 4) {
    throw new Error(`revised verdictCode invalid: ${decoded.verdictCode}`);
  }
  if (decoded.deliveryDigest === ZERO_BYTES32) {
    throw new Error("revised requestData deliveryDigest must be nonzero");
  }
}
