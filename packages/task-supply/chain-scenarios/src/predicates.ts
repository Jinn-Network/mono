// SPDX-License-Identifier: Apache-2.0

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AbiArg, Predicate } from "@jinn-network/task-execution-profiles";

import { normalizeAddress } from "./fixture-accounts.js";

/** CE5 predicate authors set `label` to the checklist-stable predicate id. */
export type ScenarioPredicate = Predicate & { readonly label: string };

export function predicateId(predicate: Predicate): string | undefined {
  return "label" in predicate && typeof predicate.label === "string" ? predicate.label : undefined;
}

function withId(id: string, predicate: Predicate): ScenarioPredicate {
  return { ...predicate, label: id };
}

export function eventSignatureTopic0(signature: string): `0x${string}` {
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(signature)))}` as `0x${string}`;
}

const STUB_ABI_REF = {
  digest: { sha256: "a".repeat(64) },
} as const;

type ComparisonOp = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

interface NumericComparison {
  readonly cmp: ComparisonOp | "within-abs" | "within-rel";
  readonly value: string;
  readonly tolerance?: string;
}

export function erc20Balance(input: {
  readonly id: string;
  readonly token: string;
  readonly account: string;
} & NumericComparison): ScenarioPredicate {
  return withId(input.id, {
    kind: "erc20Balance",
    token: normalizeAddress(input.token),
    account: normalizeAddress(input.account),
    cmp: input.cmp,
    value: input.value,
    ...(input.tolerance !== undefined ? { tolerance: input.tolerance } : {}),
  });
}

export function nativeBalance(input: {
  readonly id: string;
  readonly account: string;
} & NumericComparison): ScenarioPredicate {
  return withId(input.id, {
    kind: "nativeBalance",
    account: normalizeAddress(input.account),
    cmp: input.cmp,
    value: input.value,
    ...(input.tolerance !== undefined ? { tolerance: input.tolerance } : {}),
  });
}

export function callResult(input: {
  readonly id: string;
  readonly to: string;
  readonly abiRef?: { readonly digest: { readonly sha256: string } };
  readonly function: string;
  readonly args: readonly AbiArg[];
  readonly decode: "raw" | "uint256" | "int256";
} & NumericComparison): ScenarioPredicate {
  return withId(input.id, {
    kind: "callResult",
    to: normalizeAddress(input.to),
    call: {
      abiRef: input.abiRef ?? STUB_ABI_REF,
      function: input.function,
      args: [...input.args],
    },
    decode: input.decode,
    cmp: input.cmp,
    value: input.value,
    ...(input.tolerance !== undefined ? { tolerance: input.tolerance } : {}),
  });
}

export function eventEmitted(input: {
  readonly id: string;
  readonly source: string;
  readonly signature: string;
  readonly countCmp: { readonly cmp: ComparisonOp; readonly value: string };
}): ScenarioPredicate {
  return withId(input.id, {
    kind: "eventEmitted",
    source: normalizeAddress(input.source),
    topic0: eventSignatureTopic0(input.signature),
    countCmp: input.countCmp,
  });
}

export function eventForbidden(input: {
  readonly id: string;
  readonly source?: string;
  readonly signature: string;
}): ScenarioPredicate {
  return withId(input.id, {
    kind: "eventForbidden",
    ...(input.source !== undefined ? { source: normalizeAddress(input.source) } : {}),
    topic0: eventSignatureTopic0(input.signature),
  });
}

export function approvalConstraint(input: {
  readonly id: string;
  readonly token?: string;
  readonly owner?: string;
  readonly noUnlimited: boolean;
  readonly allowedSpenders?: readonly string[];
  readonly maxAllowance?: string;
}): ScenarioPredicate {
  return withId(input.id, {
    kind: "approvalConstraint",
    noUnlimited: input.noUnlimited,
    ...(input.token !== undefined ? { token: normalizeAddress(input.token) } : {}),
    ...(input.owner !== undefined ? { owner: normalizeAddress(input.owner) } : {}),
    ...(input.allowedSpenders !== undefined
      ? { allowedSpenders: input.allowedSpenders.map(normalizeAddress) }
      : {}),
    ...(input.maxAllowance !== undefined ? { maxAllowance: input.maxAllowance } : {}),
  });
}

export function addressForbidden(input: {
  readonly id: string;
  readonly targets: readonly string[];
}): ScenarioPredicate {
  return withId(input.id, {
    kind: "addressForbidden",
    targets: input.targets.map(normalizeAddress),
  });
}

export function budget(input: {
  readonly id: string;
  readonly metric: "gasTotal" | "txCount" | "valueOutWei";
  readonly cmp: ComparisonOp;
  readonly value: string;
}): ScenarioPredicate {
  return withId(input.id, {
    kind: "budget",
    metric: input.metric,
    cmp: input.cmp,
    value: input.value,
  });
}

export function txOutcome(input: {
  readonly id: string;
  readonly all?: true;
  readonly index?: string;
  readonly status: "success" | "reverted";
}): ScenarioPredicate {
  return withId(input.id, {
    kind: "txOutcome",
    selector: input.all === true ? { all: true } : { index: input.index ?? "0" },
    status: input.status,
  });
}

export function timeBound(input: {
  readonly id: string;
  readonly completedWithinChainSeconds: number | string;
}): ScenarioPredicate {
  const maximum =
    typeof input.completedWithinChainSeconds === "number"
      ? String(input.completedWithinChainSeconds)
      : input.completedWithinChainSeconds;
  return withId(input.id, {
    kind: "timeBound",
    metric: "completedWithinChainSeconds",
    maximum,
  });
}

export function reportedValue(input: {
  readonly id: string;
  readonly name: string;
  readonly to: string;
  readonly function: string;
  readonly args: readonly AbiArg[];
  readonly decode: "raw" | "uint256" | "int256";
  readonly groundTruthState?: "baseline" | "post-replay";
} & NumericComparison): ScenarioPredicate {
  return withId(input.id, {
    kind: "reportedValue",
    name: input.name,
    cmp: input.cmp,
    value: input.value,
    ...(input.tolerance !== undefined ? { tolerance: input.tolerance } : {}),
    groundTruth: {
      to: normalizeAddress(input.to),
      call: {
        abiRef: STUB_ABI_REF,
        function: input.function,
        args: [...input.args],
      },
      decode: input.decode,
    },
    ...(input.groundTruthState !== undefined ? { groundTruthState: input.groundTruthState } : {}),
  });
}
