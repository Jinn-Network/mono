/**
 * Native trust-catalog fixture for the native e2e rig (one-swap M7, umbrella #2461).
 *
 * The hand-rolled policy/binding/catalog assembly this file used to carry is gone: authoring is
 * `@jinn-network/trust-authoring`'s job now (spec/2026-08-07 §3.4), and the fixture consumes it.
 * That is what makes the rig's LEG 0/1 a real proof — the same code an operator's ceremony runs
 * produces the artifacts the production `openNativeTrustCatalog` / `openRoleIdentitySet` then open.
 *
 * What is genuinely rig-specific stays here:
 *   - the deterministic shared anchor digest (one anchor tx per rig run),
 *   - the anchor duality: no `submitAnchor` → a MOCK `NativeFinalizedAnchorReadClient` so a unit
 *     test can drive `openNativeTrustCatalog` without a chain; `submitAnchor` supplied → the fork
 *     rig's real finalized calldata tx, read back through the production anchor client,
 *   - the `bootTime` return contract (bindings' `validFrom`, which the caller must pass as `now`).
 */
import {
  anchorDeclaration,
  authorCatalog,
  authorRoleBinding,
  completePolicyPurposes,
  isSettlementRole,
  performEoaCeremony,
  NATIVE_ANCHOR_CHAIN_ID,
  NATIVE_ANCHOR_PROFILE,
  type AnchorLocator as AuthoringAnchorLocator,
  type CatalogAuthoritySigner,
  type SealedBindingEntry,
} from '@jinn-network/trust-authoring';
import { recordDigest } from '@jinn-network/trust-core';
import type { NativeFinalizedAnchorReadClient } from '../../../../src/daemon/native-trust-catalog.js';
import type { FixtureRoleKey } from './identity.js';

const CATALOG_CHAIN_ID = NATIVE_ANCHOR_CHAIN_ID;
const CATALOG_REFRESH_BY = '2027-01-01T00:00:00.000Z';

/** A viem-account-shaped signer for the EOA key-binding ceremony (address + `signMessage`). */
export interface CeremonyAccount {
  readonly address: `0x${string}`;
  signMessage(input: { readonly message: { readonly raw: Uint8Array } }): Promise<`0x${string}`>;
}

/** The locator a real anchor submitter returns; the fixture embeds it verbatim in the catalog. */
export interface AnchorLocator {
  readonly transactionHash: `0x${string}`;
  readonly contractAddress: `0x${string}`;
  readonly inputByteOffset: number;
  /**
   * The anchor's on-chain block time. The catalog binds `validFrom` to it VERBATIM so
   * `effectiveStart` is the anchor time and the §7.4a incumbent-voucher window check holds (see
   * `anchor.ts`). Omitted by the mock path, where `validFrom` is fixed and the mock observation's
   * time matches it.
   */
  readonly anchorTime?: string;
}

/** Given the anchor digest, write a finalized calldata tx carrying it and return its locator. */
export type AnchorSubmitter = (digest: `sha256:${string}`) => Promise<AnchorLocator>;

/** A role key plus the agent that owns it (fleet roles → agentIri; admission → admissionAgent). */
export interface OwnedRoleKey {
  readonly key: FixtureRoleKey;
  readonly agent: string;
}

export interface AuthoredTrustCatalog {
  readonly path: string;
  readonly policyGenesisDigest: `sha256:${string}`;
  readonly anchorDigest: `sha256:${string}`;
  /**
   * The effective time (`= validFrom`) every binding is minted at. The caller MUST pass this as
   * `now` to `openNativeTrustCatalog` / `openRoleIdentitySet`, because on a fork the anchor block
   * time can drift ahead of wall-clock; booting at `validFrom` keeps the window checks self-consistent.
   */
  readonly bootTime: string;
  /** Present only when no `submitAnchor` was supplied — drive `openNativeTrustCatalog` with it. */
  readonly mockAnchorClient?: NativeFinalizedAnchorReadClient;
}

export async function authorNativeTrustCatalog(input: {
  readonly path: string;
  readonly roleKeys: readonly OwnedRoleKey[];
  readonly ceremonyAccount: CeremonyAccount;
  /** A's service Safe — the settlement authority declared as the §2.3b third ceremony resource. */
  readonly settlementSafe?: `0x${string}`;
  readonly authority?: CatalogAuthoritySigner;
  readonly submitAnchor?: AnchorSubmitter;
  /** Binding/policy validFrom for the MOCK path; ignored on the fork path (anchor time wins). */
  readonly validFrom?: string;
}): Promise<AuthoredTrustCatalog> {
  const anchorDigest = recordDigest(new TextEncoder().encode('native-fleet-e2e-shared-anchor'));

  // Submit the anchor FIRST (deterministic digest, independent of the bindings): its on-chain block
  // time becomes `validFrom` so `effectiveStart = max(validFrom, anchorTime) = validFrom`, keeping
  // the §7.4a incumbent-voucher window self-consistent on a fork. The mock path has no chain, so it
  // keeps a fixed validFrom and a mock observation whose time equals it.
  const locator: AnchorLocator = input.submitAnchor !== undefined
    ? await input.submitAnchor(anchorDigest)
    : { transactionHash: `0x${'ab'.repeat(32)}`, contractAddress: `0x${'cd'.repeat(20)}`, inputByteOffset: 0 };
  const validFrom = locator.anchorTime ?? input.validFrom ?? '2026-08-01T00:00:00.000Z';

  const authority = input.authority ?? fixtureAuthorityFrom(input.roleKeys);
  const settlementSafe = input.settlementSafe ?? (input.ceremonyAccount.address);

  const bindings: SealedBindingEntry[] = [];
  for (const { key, agent } of input.roleKeys) {
    // eslint-disable-next-line no-await-in-loop -- bounded, deterministic per-role authoring.
    const ceremony = await performEoaCeremony({
      signer: input.ceremonyAccount,
      agent,
      didKey: key.keyId,
      issuedAt: validFrom,
      ...(isSettlementRole(key.role) ? { settlementSafe } : {}),
    });
    // eslint-disable-next-line no-await-in-loop -- bounded, deterministic per-role authoring.
    bindings.push(await authorRoleBinding({
      role: key.role,
      signer: key,
      agent,
      ceremonyAccount: input.ceremonyAccount.address,
      ceremony,
      validFrom,
      anchorDigest,
    }));
  }

  const authoringLocator: AuthoringAnchorLocator = {
    profile: NATIVE_ANCHOR_PROFILE,
    chainId: CATALOG_CHAIN_ID,
    transactionHash: locator.transactionHash,
    contractAddress: locator.contractAddress,
    inputByteOffset: locator.inputByteOffset,
    anchorTime: validFrom,
  };
  const { policyGenesisDigest } = await authorCatalog({
    path: input.path,
    authority,
    // §6 law 3 completeness, including both admission spellings and evaluator-eligibility.
    purposes: completePolicyPurposes({
      roleAgents: input.roleKeys.map(({ key, agent }) => ({ role: key.role, agent })),
    }),
    refreshBy: CATALOG_REFRESH_BY,
    bindings,
    anchors: [anchorDeclaration(anchorDigest, authoringLocator)],
  });

  return {
    path: input.path,
    policyGenesisDigest,
    anchorDigest,
    bootTime: validFrom,
    ...(input.submitAnchor === undefined
      ? {
          mockAnchorClient: {
            async lookupFinalizedAnchor(lookup) {
              if (lookup.digest !== anchorDigest) return null;
              return {
                digest: anchorDigest,
                anchorTime: validFrom,
                chainId: CATALOG_CHAIN_ID,
                transactionHash: locator.transactionHash,
                blockHash: `0x${'ef'.repeat(32)}`,
                blockNumber: 1n,
                finalized: true,
              };
            },
          },
        }
      : {}),
  };
}

/**
 * The rig has no deploy coordinator, so it borrows a role key as the policy signer. Production
 * NEVER does this (spec §5: policy-update capability must survive any operator's rotation); the
 * ceremony CLI opens a dedicated `openCatalogAuthority` store instead, and callers that want the
 * production shape here pass `authority` explicitly.
 */
function fixtureAuthorityFrom(roleKeys: readonly OwnedRoleKey[]): CatalogAuthoritySigner {
  const first = roleKeys[0];
  if (first === undefined) throw new Error('native trust catalog fixture requires at least one role key');
  return { keyId: first.key.keyId, dsseSigner: first.key.dsseSigner };
}
