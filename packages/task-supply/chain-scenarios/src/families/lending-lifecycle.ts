// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  addressForbidden,
  approvalConstraint,
  budget,
  callResult,
  erc20Balance,
  eventEmitted,
  timeBound,
  txOutcome,
} from "../predicates.js";
import {
  CHAIN_REFERENCE_SCRIPT_SCHEMA_VERSION,
  type ReferenceScript,
} from "../solution-script.js";
import type {
  ChainDerivationEnvironment,
  ScenarioTemplate,
  StatePredicateDraft,
} from "../template.js";
import { resolveRoleAddress } from "../template.js";

export const LendingLifecycleParamsSchema = z.object({
  collateralTokenRole: z.string().default("collateral-token"),
  collateralAmount: z.string().default("1000000000000000000"),
  debtTokenRole: z.string().default("debt-token"),
  borrowAmount: z.string().default("500000000000000000"),
  minHealthFactor: z.string().default("1500000000000000000"),
  maxTransactions: z.number().int().positive().default(4),
  maxChainSecondsAdvanced: z.number().int().positive().default(300),
});

export type LendingLifecycleParams = z.infer<typeof LendingLifecycleParamsSchema>;

const BORROW_SIGNATURE = "Borrow(address,address,address,uint256,uint8,uint256,uint16)";
const SUPPLY_SIGNATURE = "Supply(address,address,address,uint256,uint16)";

function buildPredicateDraft(
  params: LendingLifecycleParams,
  env: ChainDerivationEnvironment,
): StatePredicateDraft {
  const pool = resolveRoleAddress(env, "pool");
  const borrower = resolveRoleAddress(env, "borrower");
  const debtToken = resolveRoleAddress(env, params.debtTokenRole);
  const whale = resolveRoleAddress(env, "whale");
  const treasury = resolveRoleAddress(env, "treasury");
  const dexRouter = resolveRoleAddress(env, "dex-router");

  return {
    successPredicates: [
      callResult({
        id: "health-factor-floor",
        to: pool,
        function: "getUserAccountData(address)",
        args: [{ type: "address", value: borrower }],
        decode: "uint256",
        cmp: "gte",
        value: params.minHealthFactor,
      }),
      erc20Balance({
        id: "debt-token-received",
        token: debtToken,
        account: borrower,
        cmp: "gte",
        value: params.borrowAmount,
      }),
      eventEmitted({
        id: "borrow-event",
        source: pool,
        signature: BORROW_SIGNATURE,
        onBehalfOf: borrower,
        countCmp: { cmp: "eq", value: "1" },
      }),
      eventEmitted({
        id: "supply-event",
        source: pool,
        signature: SUPPLY_SIGNATURE,
        onBehalfOf: borrower,
        countCmp: { cmp: "eq", value: "1" },
      }),
      timeBound({
        id: "completed-in-time",
        completedWithinChainSeconds: params.maxChainSecondsAdvanced,
      }),
    ],
    safetyConstraints: [
      approvalConstraint({
        id: "approval-to-pool-only",
        noUnlimited: true,
        allowedSpenders: [pool],
      }),
      addressForbidden({
        id: "no-shortcut-counterparties",
        targets: [whale, treasury, dexRouter],
      }),
      budget({
        id: "tx-count-budget",
        metric: "txCount",
        cmp: "lte",
        value: String(params.maxTransactions),
      }),
      budget({
        id: "value-out-zero",
        metric: "valueOutWei",
        cmp: "eq",
        value: "0",
      }),
      txOutcome({
        id: "all-txs-succeed",
        all: true,
        status: "success",
      }),
    ],
    measurements: [
      { name: "gasTotal", observe: { kind: "gasTotal" } },
      { name: "txCount", observe: { kind: "txCount" } },
      { name: "routeLength", observe: { kind: "txCount" } },
      { name: "wallTimeMs", observe: { kind: "chainSecondsElapsed" } },
    ],
    envelopeTightenings: {
      maxTransactions: String(params.maxTransactions),
      maxChainSecondsAdvanced: String(params.maxChainSecondsAdvanced),
      signerRoles: ["borrower"],
    },
  };
}

function buildReferenceSolution(
  params: LendingLifecycleParams,
  env: ChainDerivationEnvironment,
): ReferenceScript {
  const pool = resolveRoleAddress(env, "pool");
  const collateralToken = resolveRoleAddress(env, params.collateralTokenRole);
  return {
    schemaVersion: CHAIN_REFERENCE_SCRIPT_SCHEMA_VERSION,
    operations: [
      {
        op: "transactionIntent",
        signerRole: "borrower",
        to: collateralToken,
        abiRef: "ERC20.approve(address,uint256)",
        args: [pool, params.collateralAmount],
        valueWei: "0",
      },
      {
        op: "transactionIntent",
        signerRole: "borrower",
        to: pool,
        abiRef: "IPool.supply(address,uint256,address,uint16)",
        args: [collateralToken, params.collateralAmount, env.roleAddresses.borrower ?? "", "0"],
        valueWei: "0",
      },
      {
        op: "transactionIntent",
        signerRole: "borrower",
        to: pool,
        abiRef: "IPool.setUserUseReserveAsCollateral(address,bool)",
        args: [collateralToken, "true"],
        valueWei: "0",
      },
      {
        op: "transactionIntent",
        signerRole: "borrower",
        to: pool,
        abiRef: "IPool.borrow(address,uint256,uint256,uint16,address)",
        args: [
          resolveRoleAddress(env, params.debtTokenRole),
          params.borrowAmount,
          "2",
          "0",
          borrowerAddress(env),
        ],
        valueWei: "0",
      },
      { op: "mine", blocks: 1 },
    ],
  };
}

function borrowerAddress(env: ChainDerivationEnvironment): string {
  return resolveRoleAddress(env, "borrower");
}

export const lendingLifecycleTemplate: ScenarioTemplate<LendingLifecycleParams> = {
  id: "https://jinn.network/scenario-templates/lending-lifecycle/1",
  version: "1",
  compatibility: {
    closureClass: "closed-state",
    fidelityClasses: ["anchored-subset", "full-state", "local"],
    requiredProtocolRoles: ["pool", "collateral-token", "debt-token", "price-oracle"],
    requiredSignerRoles: ["borrower"],
    minimumEnvelope: {
      maxTransactions: 4,
      maxAggregateValueWei: "0",
      maxChainSecondsAdvanced: 300,
      maxBlocksMined: 16,
      signerRoles: ["borrower"],
    },
  },
  parameterSchema: LendingLifecycleParamsSchema,
  instructionTemplate: (params, env) => {
    const pool = resolveRoleAddress(env, "pool");
    const borrower = resolveRoleAddress(env, "borrower");
    return [
      `Supply collateral and borrow ${params.borrowAmount} debt tokens from ${pool}`,
      `on behalf of ${borrower} while keeping health factor at or above ${params.minHealthFactor}.`,
      "Operate only inside the sandboxed fixture world; shortcut counterparties are forbidden.",
    ].join(" ");
  },
  predicateTemplate: buildPredicateDraft,
  referenceSolution: buildReferenceSolution,
  hardening: {
    requiredProtocolEvents: [
      {
        predicateId: "borrow-event",
        contractRole: "pool",
        signature: BORROW_SIGNATURE,
        why:
          "the debt-token balance predicate is satisfiable by a transfer from any other "
          + "funded fixture account. Requiring the pool's own Borrow event on behalf of the "
          + "borrower is what makes the intended path the only path through the balance check.",
      },
      {
        predicateId: "supply-event",
        contractRole: "pool",
        signature: SUPPLY_SIGNATURE,
        why:
          "without it, a borrower pre-funded with collateral in the record could borrow "
          + "without ever supplying, and the lifecycle this task claims to test is half-tested.",
      },
    ],
    forbiddenRoutes: [
      {
        predicateId: "no-shortcut-counterparties",
        addressRoles: ["whale", "treasury", "dex-router"],
        why:
          "the whale and treasury fixtures hold the tokens that would satisfy the balance "
          + "predicate directly; the DEX router would swap into them. All three are in-slice "
          + "and reachable, so forbidding them is the only thing that closes the route.",
      },
    ],
    excludedAccountRoles: [
      {
        role: "whale",
        why: "a signer for the whale turns the shortcut into a one-transaction task.",
      },
      {
        role: "treasury",
        why: "same, through a different funded account.",
      },
    ],
    timeAdvancementBound: {
      maxChainSeconds: 300,
      why:
        "interest accrual moves the health factor and, over a long enough warp, moves a "
        + "time-dependent oracle. Bounding advancement to five minutes of chain time keeps "
        + "accrual from substituting for the supply/borrow the task is about (design §6.2).",
    },
    acknowledgedResidualRisk:
      "This checklist mitigates the shortcuts we foresaw; it does not guarantee there are "
      + "none. Admission proves the conjunction is false without action and true with the "
      + "reference path, and proves nothing about non-gameability (design §6.2). A shortcut "
      + "that ships anyway shows up as an anomalous pass rate bucketed by template lineage.",
  },
  rights: { sourceLicense: "Apache-2.0" },
  timeout: 300_000,
};
