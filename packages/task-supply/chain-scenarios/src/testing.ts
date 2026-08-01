// SPDX-License-Identifier: Apache-2.0

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CRYPTO_ENVIRONMENT_MEDIA_TYPE,
  chainEnvironmentRecordDigest,
  sealChainEnvironmentRecord,
  sealCryptoEnvironmentRecord,
} from "@jinn-network/chain-environment-record";
import type {
  ChainAdmissionReceiptV1,
  ChainAdmissionRefusalCode,
  ChainAdmissionResult,
  ChainObservation,
} from "@jinn-network/task-admission";
import {
  admitChainCandidate,
  verifyChainAdmissionReceiptV1,
  goldenChainCandidate,
  goldenChainReceipt,
  scriptedChainPort,
  describeChainAdmissionConformance,
} from "@jinn-network/task-admission/testing";
import {
  assertEntryDigests,
  poolEntryConflictKeyBytes,
  type PoolEntry,
  type PoolEntrySummary,
  type SupplyPool,
} from "@jinn-network/task-derivation";
import { describeSupplyPoolConformance } from "@jinn-network/task-derivation/testing";
import type { CanonicalChainObservation, StatePredicateBlock } from "@jinn-network/task-execution-profiles";
import {
  evaluatePredicates,
  PREDICATE_SEMANTICS_VERSION,
  stateReadKey,
} from "@jinn-network/task-execution-profiles";
import { readFileSync } from "node:fs";

import { documentDigest, toBareHex } from "./digest.js";
import { ScenarioError } from "./errors.js";
import {
  type ScenarioAccount,
  type ScenarioAccountPort,
} from "./fixture-accounts.js";
import type { ChainAdmissionPort, ChainAdmissionRequest } from "./run.js";
import { CHAIN_SCENARIO_STRATEGY_ID } from "./strategy.js";
import type { ChainDerivationEnvironment, ScenarioTemplate } from "./template.js";
import {
  buildApprovalChainRecordBody,
  buildCompositeRecordBody,
  buildLendingChainRecordBody,
  fixtureRoleAddress,
  type FixtureSourceBundle,
} from "./fixture-sources.js";
import {
  ApprovalHygieneParamsSchema,
  type ApprovalHygieneParams,
} from "./families/approval-hygiene.js";
import {
  LendingLifecycleParamsSchema,
  lendingLifecycleTemplate,
  type LendingLifecycleParams,
} from "./families/lending-lifecycle.js";
import { eventSignatureTopic0, addressIndexedTopic } from "./predicates.js";
import { loadChainDerivationEnvironment } from "./strategy.js";
import type { StatePredicateDraft } from "./template.js";
import { resolveRoleAddress } from "./template.js";

const STUB_ABI_DIGEST = "a".repeat(64);
const BORROW_SIGNATURE = "Borrow(address,address,address,uint256,uint8,uint256,uint16)";
const SUPPLY_SIGNATURE = "Supply(address,address,address,uint256,uint16)";
const APPROVAL_SIGNATURE = "Approval(address,address,uint256)";
const UNSAFE_ALLOWANCE = 10_000_000_000_000_000_000n;

const FIXTURES_ROOT = fileURLToPath(new URL("../fixtures/", import.meta.url));

function roleAddress(byte: string): string {
  return fixtureRoleAddress(byte);
}

async function readFixtureBytes(rel: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(FIXTURES_ROOT, rel)));
}

export function buildLendingFixtureSource(): FixtureSourceBundle {
  const chain = buildLendingChainRecordBody();
  const chainBytes = sealChainEnvironmentRecord(chain);
  const chainDigestBare = chainEnvironmentRecordDigest(chainBytes).slice("sha256:".length);
  return { chain, composite: buildCompositeRecordBody(chainDigestBare) };
}

export function buildApprovalFixtureSource(): FixtureSourceBundle {
  const chain = buildApprovalChainRecordBody();
  const chainBytes = sealChainEnvironmentRecord(chain);
  const chainDigestBare = chainEnvironmentRecordDigest(chainBytes).slice("sha256:".length);
  return { chain, composite: buildCompositeRecordBody(chainDigestBare) };
}

async function loadSealedEnvironment(
  compositeRel: string,
  chainRel: string,
): Promise<ChainDerivationEnvironment> {
  const compositeBytes = await readFixtureBytes(compositeRel);
  const chainBytes = await readFixtureBytes(chainRel);
  return loadChainDerivationEnvironment(compositeBytes, chainBytes);
}

export function fixtureEnvironment(): ChainDerivationEnvironment {
  const { chain, composite } = buildLendingFixtureSource();
  const chainBytes = sealChainEnvironmentRecord(chain);
  const compositeBytes = sealCryptoEnvironmentRecord(composite);
  return loadChainDerivationEnvironment(compositeBytes, chainBytes);
}

export function approvalHygieneFixtureEnvironment(): ChainDerivationEnvironment {
  const { chain, composite } = buildApprovalFixtureSource();
  const chainBytes = sealChainEnvironmentRecord(chain);
  const compositeBytes = sealCryptoEnvironmentRecord(composite);
  return loadChainDerivationEnvironment(compositeBytes, chainBytes);
}

export async function loadPinnedLendingEnvironment(): Promise<ChainDerivationEnvironment> {
  return loadSealedEnvironment("environment/record.sealed.json", "environment/chain.sealed.json");
}

export async function loadPinnedApprovalEnvironment(): Promise<ChainDerivationEnvironment> {
  return loadSealedEnvironment(
    "environment/approval-record.sealed.json",
    "environment/approval-chain.sealed.json",
  );
}

export function fixtureFiles(): string[] {
  const files: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  }
  walk(FIXTURES_ROOT);
  return files;
}

export const LENDING_PARAMS: LendingLifecycleParams = LendingLifecycleParamsSchema.parse({});
export const APPROVAL_HYGIENE_PARAMS: ApprovalHygieneParams = ApprovalHygieneParamsSchema.parse({});

function stripSignerRoles(
  tightenings: StatePredicateDraft["envelopeTightenings"],
): StatePredicateBlock["envelopeTightenings"] | undefined {
  if (tightenings === undefined) return undefined;
  const { signerRoles: _signerRoles, ...rest } = tightenings;
  if (Object.keys(rest).length === 0) return undefined;
  return rest;
}

function uint256Word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}` as `0x${string}`;
}

function healthFactorReadKey(pool: string, borrower: string): string {
  return stateReadKey({
    kind: "call",
    to: pool,
    call: {
      abiRef: { digest: { sha256: STUB_ABI_DIGEST } },
      function: "getUserAccountData(address)",
      args: [{ type: "address", value: borrower }],
    },
  });
}

function debtBalanceReadKey(debtToken: string, borrower: string): string {
  return stateReadKey({ kind: "erc20Balance", token: debtToken, account: borrower });
}

function observationShell(env: ChainDerivationEnvironment): CanonicalChainObservation {
  const digest = env.recordDigest.slice("sha256:".length);
  return {
    observationVersion: "1",
    environmentRecord: `sha256:${digest}`,
    informationWorlds: ["fixture-world"],
    replay: { status: "completed" },
    timeline: {
      initialBlockNumber: "21000001",
      initialChainTimestamp: "1735689612",
      finalStateChangingBlockNumber: "21000001",
      finalStateChangingChainTimestamp: "1735689612",
    },
    transactions: [],
    blocks: [{
      number: "21000001",
      timestamp: "1735689612",
      hash: `0x${"0".repeat(64)}`,
    }],
    touchedState: [],
    traceProjectionDigest: `sha256:${"b".repeat(64)}`,
    finalStateCommitment: `0x${"c".repeat(64)}`,
    errorClasses: [],
    stateReads: [],
    sourceReads: [],
    sourceConsultations: [],
    reports: [],
  };
}

function protocolEventTopics(
  reserve: string,
  user: string,
  onBehalfOf: string,
): [`0x${string}`, `0x${string}`, `0x${string}`] {
  return [
    addressIndexedTopic(reserve),
    addressIndexedTopic(user),
    addressIndexedTopic(onBehalfOf),
  ];
}

function successTransaction(
  index: number,
  logs: CanonicalChainObservation["transactions"][number]["logs"],
): CanonicalChainObservation["transactions"][number] {
  return {
    index: String(index),
    hash: `0x${String(index).padStart(64, "0")}`,
    from: roleAddress("08"),
    to: roleAddress("01"),
    valueWei: "0",
    status: "success",
    gasUsed: "100000",
    returnData: "0x",
    logs,
    blockNumber: "21000002",
    blockTimestamp: "1735689624",
  };
}

export function baselineObservation(): CanonicalChainObservation {
  const env = fixtureEnvironment();
  const pool = resolveRoleAddress(env, "pool");
  const borrower = resolveRoleAddress(env, "borrower");
  const collateral = resolveRoleAddress(env, LENDING_PARAMS.collateralTokenRole);
  const debtToken = resolveRoleAddress(env, LENDING_PARAMS.debtTokenRole);
  const minHealth = BigInt(LENDING_PARAMS.minHealthFactor);
  const supplyTopics = protocolEventTopics(collateral, borrower, borrower);

  const observation = observationShell(env);
  observation.transactions = [
    successTransaction(0, [{
      index: "0",
      address: pool,
      topics: [
        eventSignatureTopic0(SUPPLY_SIGNATURE),
        ...supplyTopics,
      ],
      data: "0x",
    }]),
  ];
  observation.stateReads = [
    {
      key: healthFactorReadKey(pool, borrower),
      state: "post-replay",
      resolution: "resolved",
      value: uint256Word(minHealth + 1n),
    },
    {
      key: debtBalanceReadKey(debtToken, borrower),
      state: "post-replay",
      resolution: "resolved",
      value: uint256Word(0n),
    },
  ];
  return observation;
}

export function referenceObservation(): CanonicalChainObservation {
  const env = fixtureEnvironment();
  const pool = resolveRoleAddress(env, "pool");
  const borrower = resolveRoleAddress(env, "borrower");
  const collateral = resolveRoleAddress(env, LENDING_PARAMS.collateralTokenRole);
  const debtToken = resolveRoleAddress(env, LENDING_PARAMS.debtTokenRole);
  const borrowAmount = BigInt(LENDING_PARAMS.borrowAmount);
  const minHealth = BigInt(LENDING_PARAMS.minHealthFactor);
  const supplyTopics = protocolEventTopics(collateral, borrower, borrower);
  const borrowTopics = protocolEventTopics(debtToken, borrower, borrower);

  const observation = observationShell(env);
  observation.timeline.finalStateChangingBlockNumber = "21000005";
  observation.timeline.finalStateChangingChainTimestamp = "1735689648";
  observation.transactions = [
    successTransaction(0, []),
    successTransaction(1, [{
      index: "0",
      address: pool,
      topics: [
        eventSignatureTopic0(SUPPLY_SIGNATURE),
        ...supplyTopics,
      ],
      data: "0x",
    }]),
    successTransaction(2, []),
    successTransaction(3, [{
      index: "0",
      address: pool,
      topics: [
        eventSignatureTopic0(BORROW_SIGNATURE),
        ...borrowTopics,
      ],
      data: "0x",
    }]),
  ];
  observation.stateReads = [
    {
      key: healthFactorReadKey(pool, borrower),
      state: "post-replay",
      resolution: "resolved",
      value: uint256Word(minHealth + 1n),
    },
    {
      key: debtBalanceReadKey(debtToken, borrower),
      state: "post-replay",
      resolution: "resolved",
      value: uint256Word(borrowAmount),
    },
  ];
  return observation;
}

function allowanceReadKey(token: string, owner: string, spender: string): string {
  return stateReadKey({
    kind: "call",
    to: token,
    call: {
      abiRef: { digest: { sha256: STUB_ABI_DIGEST } },
      function: "allowance(address,address)",
      args: [
        { type: "address", value: owner },
        { type: "address", value: spender },
      ],
    },
  });
}

function tokenBalanceReadKey(token: string, account: string): string {
  return stateReadKey({ kind: "erc20Balance", token, account });
}

function approvalLog(
  token: string,
  owner: string,
  spender: string,
  amount: bigint,
): CanonicalChainObservation["transactions"][number]["logs"][number] {
  return {
    index: "0",
    address: token,
    topics: [
      eventSignatureTopic0(APPROVAL_SIGNATURE),
      addressIndexedTopic(owner),
      addressIndexedTopic(spender),
    ],
    data: uint256Word(amount),
  };
}

function ownerTransaction(
  index: number,
  to: string,
  logs: CanonicalChainObservation["transactions"][number]["logs"],
): CanonicalChainObservation["transactions"][number] {
  return {
    index: String(index),
    hash: `0x${String(index).padStart(64, "0")}`,
    from: roleAddress("12"),
    to,
    valueWei: "0",
    status: "success",
    gasUsed: "100000",
    returnData: "0x",
    logs,
    blockNumber: "21000002",
    blockTimestamp: "1735689624",
  };
}

function approvalHygieneStateReads(
  env: ChainDerivationEnvironment,
  params: ApprovalHygieneParams,
  allowances: {
    readonly unsafe: bigint;
    readonly retained: bigint;
  },
): CanonicalChainObservation["stateReads"] {
  const token = resolveRoleAddress(env, params.tokenRole);
  const owner = resolveRoleAddress(env, params.ownerRole);
  const retainedSpender = resolveRoleAddress(env, params.retainedSpenderRole);
  const startingBalance = BigInt(params.startingTokenBalance);
  const reads: CanonicalChainObservation["stateReads"] = [
    {
      key: tokenBalanceReadKey(token, owner),
      state: "post-replay",
      resolution: "resolved",
      value: uint256Word(startingBalance),
    },
    {
      key: allowanceReadKey(token, owner, retainedSpender),
      state: "post-replay",
      resolution: "resolved",
      value: uint256Word(allowances.retained),
    },
  ];
  for (const spenderRole of params.unsafeSpenderRoles) {
    const spender = resolveRoleAddress(env, spenderRole);
    reads.push({
      key: allowanceReadKey(token, owner, spender),
      state: "post-replay",
      resolution: "resolved",
      value: uint256Word(allowances.unsafe),
    });
  }
  return reads;
}

export function approvalBaselineObservation(): CanonicalChainObservation {
  const env = approvalHygieneFixtureEnvironment();
  const observation = observationShell(env);
  observation.stateReads = approvalHygieneStateReads(env, APPROVAL_HYGIENE_PARAMS, {
    unsafe: UNSAFE_ALLOWANCE,
    retained: BigInt(APPROVAL_HYGIENE_PARAMS.retainedAllowance),
  });
  return observation;
}

export function approvalReferenceObservation(): CanonicalChainObservation {
  const env = approvalHygieneFixtureEnvironment();
  const token = resolveRoleAddress(env, APPROVAL_HYGIENE_PARAMS.tokenRole);
  const owner = resolveRoleAddress(env, APPROVAL_HYGIENE_PARAMS.ownerRole);
  const observation = observationShell(env);
  observation.timeline.finalStateChangingBlockNumber = "21000004";
  observation.timeline.finalStateChangingChainTimestamp = "1735689648";
  observation.transactions = APPROVAL_HYGIENE_PARAMS.unsafeSpenderRoles.map((spenderRole, index) => {
    const spender = resolveRoleAddress(env, spenderRole);
    return ownerTransaction(index, token, [approvalLog(token, owner, spender, 0n)]);
  });
  observation.stateReads = approvalHygieneStateReads(env, APPROVAL_HYGIENE_PARAMS, {
    unsafe: 0n,
    retained: BigInt(APPROVAL_HYGIENE_PARAMS.retainedAllowance),
  });
  return observation;
}

export function approvalOverRevokedObservation(): CanonicalChainObservation {
  const env = approvalHygieneFixtureEnvironment();
  const token = resolveRoleAddress(env, APPROVAL_HYGIENE_PARAMS.tokenRole);
  const owner = resolveRoleAddress(env, APPROVAL_HYGIENE_PARAMS.ownerRole);
  const retainedSpender = resolveRoleAddress(env, APPROVAL_HYGIENE_PARAMS.retainedSpenderRole);
  const observation = approvalReferenceObservation();
  const nextIndex = observation.transactions.length;
  observation.transactions = [
    ...observation.transactions,
    ownerTransaction(nextIndex, token, [approvalLog(token, owner, retainedSpender, 0n)]),
  ];
  observation.stateReads = approvalHygieneStateReads(env, APPROVAL_HYGIENE_PARAMS, {
    unsafe: 0n,
    retained: 0n,
  });
  return observation;
}

export function predicateBlockFromDraft(
  draft: StatePredicateDraft,
  env: ChainDerivationEnvironment,
  timeout: number,
): StatePredicateBlock {
  return {
    environmentRecord: {
      digest: { sha256: toBareHex(env.recordDigest, "environmentRecord") },
      mediaType: CRYPTO_ENVIRONMENT_MEDIA_TYPE,
    },
    predicateSemanticsVersion: PREDICATE_SEMANTICS_VERSION,
    successPredicates: [...draft.successPredicates],
    safetyConstraints: [...draft.safetyConstraints],
    measurements: draft.measurements as StatePredicateBlock["measurements"],
    ...(stripSignerRoles(draft.envelopeTightenings) !== undefined
      ? { envelopeTightenings: stripSignerRoles(draft.envelopeTightenings) }
      : {}),
    timeout,
  };
}

export function predicateBlockFromTemplate<TParams>(
  template: ScenarioTemplate<TParams>,
  env: ChainDerivationEnvironment,
  params: TParams,
): StatePredicateBlock {
  const draft = template.predicateTemplate(params, env);
  return predicateBlockFromDraft(draft, env, template.timeout);
}

export const overRevokedObservation = approvalOverRevokedObservation;

export function scriptedAccountPort(addresses: readonly string[]): ScenarioAccountPort {
  let index = 0;
  return async (request): Promise<ScenarioAccount> => {
    if (index >= addresses.length) {
      throw new ScenarioError(
        "invalid-input",
        `scripted account port exhausted at role ${request.role}`,
      );
    }
    const address = addresses[index++];
    return { role: request.role, address };
  };
}

export interface StubChainAdmissionOptions {
  readonly refuse?: Record<string, ChainAdmissionRefusalCode>;
  readonly throwOn?: string;
  readonly receiptBindingOverrides?: {
    readonly taskDocumentDigest?: string;
    readonly evaluationSpecDigest?: string;
    readonly compositeRecordDigest?: string;
    readonly referenceScriptDigest?: string;
  };
}

export interface ExportedStubChainAdmissionPort extends ChainAdmissionPort {
  readonly seen: ChainAdmissionRequest[];
  readonly published: string[];
  readonly receipts: ChainAdmissionReceiptV1[];
}

function buildStubReceipt(
  request: ChainAdmissionRequest,
  overrides: StubChainAdmissionOptions["receiptBindingOverrides"] = {},
): ChainAdmissionReceiptV1 {
  const specDigest = documentDigest(request.candidate.evaluationSpecBytes);
  const referenceScriptDigest = (overrides.referenceScriptDigest
    ?? request.candidate.referenceScriptDigest) as `sha256:${string}`;
  const base = goldenChainReceipt();
  const referenceObservation = {
    ...base.observations.reference[0]!,
    appliedScriptDigest: referenceScriptDigest,
  };
  return {
    ...base,
    issuer: "urn:jinn:test:stub-chain-admission",
    task: {
      documentDigest: (overrides.taskDocumentDigest
        ?? request.candidate.taskDocumentDigest) as `sha256:${string}`,
      evaluationSpecDigest: (overrides.evaluationSpecDigest ?? specDigest) as `sha256:${string}`,
      statementDigest: request.candidate.statementDigest,
    },
    referenceScriptDigest,
    observations: {
      doNothing: base.observations.doNothing,
      reference: [referenceObservation, referenceObservation],
    },
    environment: {
      compositeRecordDigest: (overrides.compositeRecordDigest
        ?? request.environmentCompositeDigest) as `sha256:${string}`,
    },
    evalSemanticsVersion: request.candidate.evalSemanticsVersion,
  };
}

export function stubChainAdmissionPort(
  options: StubChainAdmissionOptions = {},
): ExportedStubChainAdmissionPort {
  const seen: ChainAdmissionRequest[] = [];
  const published: string[] = [];
  const receipts: ChainAdmissionReceiptV1[] = [];
  let counter = 0;

  return {
    seen,
    published,
    receipts,
    async admit(request: ChainAdmissionRequest): Promise<ChainAdmissionResult> {
      seen.push(request);
      if (options.throwOn !== undefined && request.candidateId === options.throwOn) {
        throw new Error("admission port unavailable");
      }
      const refusalCode = options.refuse?.[request.candidateId];
      if (refusalCode !== undefined) {
        return { refusal: { code: refusalCode, detail: "scripted refusal" } };
      }
      const receipt = buildStubReceipt(request, options.receiptBindingOverrides);
      receipts.push(receipt);
      return { receipt };
    },
    async publishReceipt() {
      counter += 1;
      const digest = `sha256:${String(counter).padStart(64, "0")}` as const;
      published.push(digest);
      return { digest };
    },
  };
}

export function inMemorySupplyPool(): SupplyPool {
  const store = new Map<string, PoolEntry>();

  return {
    async put(entry: PoolEntry): Promise<PoolEntrySummary> {
      assertEntryDigests(entry);
      const key = new TextDecoder().decode(poolEntryConflictKeyBytes(entry));
      store.set(key, entry);
      const { taskBytes: _taskBytes, evaluationSpecBytes: _specBytes, ...summary } = entry;
      return summary;
    },
    async get(taskDigest: string): Promise<PoolEntry | undefined> {
      for (const entry of store.values()) {
        if (entry.taskDigest === taskDigest) return entry;
      }
      return undefined;
    },
    async list(): Promise<readonly PoolEntrySummary[]> {
      return [...store.values()].map(
        ({ taskBytes: _taskBytes, evaluationSpecBytes: _specBytes, ...summary }) => summary,
      );
    },
  };
}

let cachedConformanceEntry: PoolEntry | undefined;

export function buildConformancePoolEntry(): PoolEntry {
  if (cachedConformanceEntry === undefined) {
    const taskBytes = new Uint8Array(
      readFileSync(join(FIXTURES_ROOT, "golden/lending-lifecycle/task.bytes")),
    );
    const specBytes = new Uint8Array(
      readFileSync(join(FIXTURES_ROOT, "golden/lending-lifecycle/evaluation-spec.bytes")),
    );
    const env = fixtureEnvironment();
    const taskDigest = documentDigest(taskBytes);
    const specDigest = documentDigest(specBytes);
    cachedConformanceEntry = {
      taskDigest,
      taskBytes,
      evaluationSpecDigest: specDigest,
      evaluationSpecBytes: specBytes,
      receiptDigest: `sha256:${"7".repeat(64)}`,
      environmentRecordDigest: env.recordDigest,
      strategyId: CHAIN_SCENARIO_STRATEGY_ID,
      provenance: {
        kind: "synthetic",
        sourceCommitment: taskDigest,
        lineage: {
          templateId: lendingLifecycleTemplate.id,
          templateVersion: lendingLifecycleTemplate.version,
          parameterDigest: taskDigest,
          environmentRecordDigest: env.recordDigest,
        },
      },
      rights: { sourceLicense: lendingLifecycleTemplate.rights.sourceLicense },
    };
  }
  return cachedConformanceEntry;
}

export function chainObservationFromCanonical(
  observation: CanonicalChainObservation,
  block: StatePredicateBlock,
  appliedScriptDigest: `sha256:${string}` | null,
): ChainObservation {
  const outcome = evaluatePredicates(observation, block);
  const successPredicates = outcome.evaluations
    .filter((entry) => entry.slot === "success")
    .map((entry) => ({
      id: entry.label ?? `${entry.slot}-${entry.index}`,
      satisfied: entry.state === "satisfied",
    }));
  const safetyConstraints = outcome.evaluations
    .filter((entry) => entry.slot === "safety")
    .map((entry) => ({
      id: entry.label ?? `${entry.slot}-${entry.index}`,
      satisfied: entry.state === "satisfied",
    }));
  return {
    successPredicates,
    safetyConstraints,
    conjunction: outcome.successPredicatesSatisfied,
    outOfSliceReads: 0,
    envelopeExceeded: false,
    appliedScriptDigest,
  };
}

export function describeChainScenarioConformance(label: string): void {
  describeSupplyPoolConformance({
    name: `${label} in-memory pool`,
    createPool: async () => ({ pool: inMemorySupplyPool() }),
    buildEntry: () => buildConformancePoolEntry(),
  });
  describeChainAdmissionConformance(label, {
    admitChainCandidate,
    goldenChainCandidate,
    goldenChainReceipt,
    scriptedChainPort,
    verifyChainReceipt: verifyChainAdmissionReceiptV1,
  });
}
