// SPDX-License-Identifier: Apache-2.0

// The conformance chain world and the composite that wraps it. Fixture addresses here were
// generated once for this record and are used nowhere else (design §8, program contract 8).
// They hold nothing on any chain. Funding one of them would turn every published solution
// script into a replayable mainnet transaction from it -- a hazard for whoever funds it, and
// the reason these keys are never reused across records.

import { createRequire } from "node:module";

import {
  chainEnvironmentRecordDigest,
  parseChainEnvironmentRecord,
  parseCryptoEnvironmentRecord,
  sealChainEnvironmentRecord,
  sealCryptoEnvironmentRecord,
  type ChainEnvironmentRecord,
  type CryptoEnvironmentRecord,
} from "@jinn-network/chain-environment-record";
import { canonicalJsonBytes, recordDigest, type Sha256Digest } from "@jinn-network/trust-core";

const require = createRequire(import.meta.url);

const closedLocalFixture = require(
  "@jinn-network/chain-environment-record/fixtures/chain/closed-local.json",
) as Record<string, unknown>;
const archiveDependentFixture = require(
  "@jinn-network/chain-environment-record/fixtures/chain/archive-dependent.json",
) as Record<string, unknown>;
const chainOnlyCompositeFixture = require(
  "@jinn-network/chain-environment-record/fixtures/composite/chain-only.json",
) as Record<string, unknown>;

export const CONFORMANCE_AGENT_ACCOUNT = "0x2f1c6ba4f0d7e4b8c9a3057e61d2b8f4a7c0e913";
export const CONFORMANCE_COUNTERPARTY_ACCOUNT = "0x8d43a5e2907c16bf4de0913a7bc25f8e04617d2a";
export const CONFORMANCE_PROTOCOL_ACCOUNT = "0xb17e05c3f4a2986d1c7be0435928fda6017c34e8";

export interface ConformanceRecordOptions {
  readonly closureClass?: "closed-state" | "archive-dependent";
  readonly fidelityClass?: "local" | "anchored-subset" | "full-state";
}

/** Bytes the verify suite's stub artifact store serves for a named resolution request. */
export function conformanceArtifactBytes(resourceName: string): Uint8Array {
  return canonicalJsonBytes({
    conformanceArtifact: resourceName,
    package: "@jinn-network/chain-environment-verification",
  });
}

function conformancePrefixedDigest(resourceName: string): Sha256Digest {
  return recordDigest(conformanceArtifactBytes(resourceName));
}

function conformanceBareDigest(resourceName: string): string {
  return conformancePrefixedDigest(resourceName).slice("sha256:".length);
}

function replaceConformanceAddresses(candidate: Record<string, unknown>): void {
  const fixtures = candidate.fixtures as {
    accounts: { role: string; address: string }[];
  };
  const agentBefore = fixtures.accounts.find((one) => one.role === "agent")?.address;
  const counterpartyBefore = fixtures.accounts.find((one) => one.role === "counterparty")?.address;
  for (const account of fixtures.accounts) {
    if (account.role === "agent") account.address = CONFORMANCE_AGENT_ACCOUNT;
    if (account.role === "counterparty") account.address = CONFORMANCE_COUNTERPARTY_ACCOUNT;
  }
  const envelope = candidate.capabilityEnvelope as {
    signerRoles: { accounts: string[] }[];
  };
  for (const role of envelope.signerRoles) {
    role.accounts = role.accounts.map((address) => {
      if (address === agentBefore) return CONFORMANCE_AGENT_ACCOUNT;
      if (address === counterpartyBefore) return CONFORMANCE_COUNTERPARTY_ACCOUNT;
      return address;
    });
  }
  const controls = candidate.determinismControls as { coinbase?: string };
  if (controls.coinbase !== undefined) {
    controls.coinbase = CONFORMANCE_PROTOCOL_ACCOUNT;
  }
}

function alignConformanceArtifacts(candidate: Record<string, unknown>): void {
  const stateMaterialization = candidate.stateMaterialization as Record<string, unknown>;
  const materializer = stateMaterialization.materializer as { digest: Sha256Digest };
  materializer.digest = conformancePrefixedDigest("materializer");

  const verificationContract = candidate.verificationContract as {
    probeSuite: { descriptor: { digest: { sha256: string } } };
    comparator: { id: string; digest: Sha256Digest };
  };
  verificationContract.probeSuite.descriptor.digest.sha256 =
    conformanceBareDigest("probe-suite");
  verificationContract.comparator.digest = conformancePrefixedDigest("comparator");

  const stateArtifact = stateMaterialization.stateArtifact as
    | { descriptor: { digest: { sha256: string } } }
    | undefined;
  if (stateArtifact !== undefined) {
    stateArtifact.descriptor.digest.sha256 = conformanceBareDigest("state-artifact");
  }

  const sourceProofManifest = stateMaterialization.sourceProofManifest as
    | { proofs: { digest: { sha256: string } } }
    | undefined;
  if (sourceProofManifest !== undefined) {
    sourceProofManifest.proofs.digest.sha256 =
      conformanceBareDigest("source-proof-manifest");
  }

  const sourceAnchor = candidate.sourceAnchor as
    | { headerProof?: { digest: { sha256: string } } }
    | undefined;
  if (sourceAnchor?.headerProof !== undefined) {
    sourceAnchor.headerProof.digest.sha256 = conformanceBareDigest("header-proof");
  }

  const fixtures = candidate.fixtures as {
    modules: { id: string; module: { digest: { sha256: string } } }[];
  };
  fixtures.modules.forEach((module, index) => {
    module.module.digest.sha256 = conformanceBareDigest(`fixture-${index}-${module.id}`);
  });
}

/**
 * Built with CE1's parser rather than as a bare literal, so a record shape this package
 * assumes but CE1 rejects fails here rather than three tasks later.
 */
export function buildConformanceChainRecord(
  options: ConformanceRecordOptions = {},
): ChainEnvironmentRecord {
  const closureClass = options.closureClass ?? "closed-state";
  const base = closureClass === "archive-dependent"
    ? structuredClone(archiveDependentFixture)
    : structuredClone(closedLocalFixture);

  if (options.fidelityClass !== undefined) {
    (base.stateMaterialization as { fidelityClass: string }).fidelityClass =
      options.fidelityClass;
  }
  if (options.closureClass !== undefined) {
    (base.stateMaterialization as { closureClass: string }).closureClass =
      options.closureClass;
  }

  replaceConformanceAddresses(base);
  alignConformanceArtifacts(base);
  return parseChainEnvironmentRecord(sealChainEnvironmentRecord(base));
}

export function buildConformanceCompositeRecord(
  _options: { readonly informationWorlds?: readonly string[] } = {},
): CryptoEnvironmentRecord {
  const chainRecord = buildConformanceChainRecord();
  const chainDigest = chainEnvironmentRecordDigest(sealChainEnvironmentRecord(chainRecord));
  const candidate = structuredClone(chainOnlyCompositeFixture) as Record<string, unknown>;
  const chainWorld = candidate.chainWorld as {
    record: { digest: { sha256: string } };
  };
  chainWorld.record.digest.sha256 = chainDigest.slice("sha256:".length);
  return parseCryptoEnvironmentRecord(sealCryptoEnvironmentRecord(candidate));
}
