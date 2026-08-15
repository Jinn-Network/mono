// SPDX-License-Identifier: Apache-2.0

import {
  CHAIN_ENVIRONMENT_KIND,
  chainEnvironmentRecordDigest,
  cryptoEnvironmentRecordDigest,
  parseChainEnvironmentRecord,
  parseCryptoEnvironmentRecord,
  type CryptoEnvironmentRecord,
} from "@jinn-network/chain-environment-record";
import type { DerivationStrategy } from "@jinn-network/task-derivation";

import type { Sha256Digest } from "./digest.js";
import { ScenarioError } from "./errors.js";
import { assertTemplateHardened } from "./hardening.js";
import { createFixtureAddressLedger, type FixtureAddressLedger, type ScenarioAccountPort } from "./fixture-accounts.js";
import { parameterize } from "./parameterize.js";
import type {
  ChainDerivationEnvironment,
  ChainScenarioCandidate,
  ScenarioTemplate,
} from "./template.js";

export type { ChainDerivationEnvironment } from "./template.js";

export const CHAIN_SCENARIO_STRATEGY_ID =
  "https://spec.jinn.network/derivation-strategies/chain-scenarios/v1" as const;

export interface ChainScenarioInputs {
  readonly template: ScenarioTemplate<never>;
  readonly parameterSets: readonly unknown[];
  readonly accounts?: ScenarioAccountPort;
  readonly ledger?: FixtureAddressLedger;
}

function roleAddressesFromChainRecord(
  chainRecord: ChainDerivationEnvironment["chainRecord"],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    chainRecord.fixtures.accounts.map((account) => [account.role, account.address]),
  );
}

function isChainEnvironmentRecordBytes(bytes: Uint8Array): boolean {
  try {
    const record = parseChainEnvironmentRecord(bytes);
    return record.kind === CHAIN_ENVIRONMENT_KIND;
  } catch {
    return false;
  }
}

/**
 * Loads a composite crypto-environment record plus its referenced chain world. Components are
 * referenced by digest (E11), so the chain record bytes must be supplied alongside the composite.
 */
export function loadChainDerivationEnvironment(
  compositeRecordBytes: Uint8Array,
  chainRecordBytes: Uint8Array,
): ChainDerivationEnvironment {
  let record: CryptoEnvironmentRecord;
  try {
    record = parseCryptoEnvironmentRecord(compositeRecordBytes);
  } catch {
    if (isChainEnvironmentRecordBytes(compositeRecordBytes)) {
      throw new ScenarioError(
        "invalid-input",
        "bytes are a chain-environment record, not a composite crypto-environment record.",
      );
    }
    throw new ScenarioError("invalid-input", "bytes are not a composite crypto-environment record.");
  }

  const chainRecord = parseChainEnvironmentRecord(chainRecordBytes);
  const chainDigestBare = chainEnvironmentRecordDigest(chainRecordBytes).slice("sha256:".length);
  const chainWorldDigest = record.chainWorld.record.digest;
  if (!chainWorldDigest) {
    throw new ScenarioError("invalid-input", "composite chainWorld reference is missing a digest.");
  }
  const referencedBare = chainWorldDigest.sha256;
  if (chainDigestBare !== referencedBare) {
    throw new ScenarioError(
      "invalid-input",
      "chain record digest does not match the composite chainWorld reference.",
    );
  }

  return {
    recordBytes: compositeRecordBytes,
    record,
    recordDigest: cryptoEnvironmentRecordDigest(compositeRecordBytes) as Sha256Digest,
    chainRecord,
    roleAddresses: roleAddressesFromChainRecord(chainRecord),
  };
}

export const chainScenarioStrategy:
  DerivationStrategy<ChainScenarioInputs, ChainScenarioCandidate, ChainDerivationEnvironment> = {
  id: CHAIN_SCENARIO_STRATEGY_ID,
  async *derive(deps, env, inputs) {
    assertTemplateHardened(inputs.template);
    const ledger = inputs.ledger ?? createFixtureAddressLedger();
    for (const [index, params] of inputs.parameterSets.entries()) {
      try {
        yield await parameterize(
          { accounts: inputs.accounts, ledger },
          inputs.template,
          params,
          env,
        );
      } catch (error) {
        if (!(error instanceof ScenarioError)) throw error;
        deps.logger?.candidateSkipped({
          candidateId: `${inputs.template.id}#${index}`,
          reason: `${error.category}: ${error.message}`,
        });
      }
    }
  },
};
