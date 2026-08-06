/**
 * Native trust-catalog fixture for the native e2e rig (one-swap M7, umbrella #2461).
 *
 * Authors the on-disk `jinn.native-trust-catalog/2` file that `openNativeTrustCatalog`
 * (`src/daemon/native-trust-catalog.ts`) reads: one sealed genesis `TrustPolicy` carrying a
 * `native:<role>` purpose per role, one self-signed `KeyBinding` per minted role key (EOA-ceremony
 * bound), and the finalized anchor every binding references.
 *
 * Anchor duality (the reason this fixture is injectable):
 *   - No `submitAnchor` → a MOCK `NativeFinalizedAnchorReadClient` is returned, so a unit test can
 *     drive `openNativeTrustCatalog` without a chain.
 *   - `submitAnchor` supplied → the caller (the fork rig) has written a REAL finalized calldata tx
 *     carrying the anchor digest, and the returned catalog's locator points at it. The rig then
 *     opens the catalog with the production `createBaseSepoliaFinalizedAnchorClient` over the fork.
 * One shared anchor digest backs every binding, so the fork rig writes exactly one anchor tx.
 *
 * The catalog is authored from the SAME `FixtureRoleKey`s the identity store was written from
 * (`identity.ts`), so the binding a role resolves to is signed by the very key the store holds —
 * the invariant `RoleIdentitySet.open` checks (`binding.key.didKey === stored.keyId`).
 */
import { writeFile } from 'node:fs/promises';
import {
  ceremonyEvidenceDigest,
  didPkh,
  recordDigest,
  sealKeyBinding,
  sealTrustPolicy,
  serializeCeremonyMessage,
  type DsseSigner,
  type EoaCeremonyEvidence,
  type KeyBinding,
  type Sha256Digest,
  type TrustPolicy,
} from '@jinn-network/trust-core';
import { hexToBytes } from 'viem';
import {
  NATIVE_ROLE_IDENTITY_REQUIREMENTS,
  type NativeRoleIdentityRole,
} from '../../../../src/daemon/role-identities.js';
import type { NativeFinalizedAnchorReadClient } from '../../../../src/daemon/native-trust-catalog.js';
import type { FixtureRoleKey } from './identity.js';

const CATALOG_CHAIN_ID = 84532 as const;
const ANCHOR_PROFILE = 'https://spec.jinn.network/trust/anchor-locators/base-sepolia-calldata-v1' as const;

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
   * The anchor's on-chain block time. The catalog binds `validFrom` to it so `effectiveStart` is the
   * anchor time and the §7.4a incumbent-voucher window check holds (see `anchor.ts`). Omitted by the
   * mock path, where `validFrom` is fixed and the mock observation's time matches it.
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

function ed25519DsseSigner(key: FixtureRoleKey): DsseSigner {
  return async ({ preAuthEncoding }) => [{ keyid: key.keyId, signature: key.sign(preAuthEncoding) }];
}

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

async function buildEoaCeremony(
  account: CeremonyAccount,
  agent: string,
  didKey: string,
  issuedAt: string,
): Promise<EoaCeremonyEvidence> {
  const message = {
    domain: 'trust.jinn.network',
    address: account.address,
    uri: 'https://trust.jinn.network/ceremony/key-binding',
    version: '1' as const,
    chainId: CATALOG_CHAIN_ID,
    nonce: `native-e2e-${didKey.slice(-8)}`,
    issuedAt,
    resources: [agent, didKey],
  };
  const messageBytes = serializeCeremonyMessage('eoa', message);
  const signature = hexToBytes(await account.signMessage({ message: { raw: messageBytes } }));
  return { type: 'eoa', message, messageBytes, signature };
}

/** Union of every trust-core family each requested role must be able to sign. */
function scopeForRole(role: NativeRoleIdentityRole): readonly string[] {
  return [...new Set(NATIVE_ROLE_IDENTITY_REQUIREMENTS[role])];
}

export async function authorNativeTrustCatalog(input: {
  readonly path: string;
  readonly roleKeys: readonly OwnedRoleKey[];
  readonly ceremonyAccount: CeremonyAccount;
  readonly submitAnchor?: AnchorSubmitter;
  /** Binding/policy validFrom for the MOCK path; ignored on the fork path (anchor time wins). */
  readonly validFrom?: string;
}): Promise<AuthoredTrustCatalog> {
  const anchorDigest = recordDigest(new TextEncoder().encode('native-fleet-e2e-shared-anchor'));

  // Submit the anchor FIRST (deterministic digest, independent of the bindings): its on-chain block
  // time becomes `validFrom` so `effectiveStart = max(validFrom, anchorTime) = validFrom`, keeping the
  // §7.4a incumbent-voucher window self-consistent on a fork. The mock path has no chain, so it keeps
  // a fixed validFrom and a mock observation whose time equals it.
  const locator: AnchorLocator = input.submitAnchor !== undefined
    ? await input.submitAnchor(anchorDigest)
    : { transactionHash: `0x${'ab'.repeat(32)}`, contractAddress: `0x${'cd'.repeat(20)}`, inputByteOffset: 0 };
  const validFrom = locator.anchorTime ?? input.validFrom ?? '2026-08-01T00:00:00.000Z';

  // A dedicated policy signer — the genesis policy is self-consistent: signed by the one key in its
  // signerSet with threshold 1 (verifyPolicyChain's `meetsThreshold`). It needs no binding/anchor.
  const policySigner = input.roleKeys[0];
  if (policySigner === undefined) throw new Error('native trust catalog fixture requires at least one role key');

  // A purpose accepts EVERY agent that owns that role — two operators sharing a role (e.g. both run
  // a solver) each need their own agent policy-accepted under the one `native:<role>` purpose, or the
  // second write would clobber the first and reject the first operator's binding.
  const acceptedByPurpose = new Map<string, Set<string>>();
  for (const { key, agent } of input.roleKeys) {
    const purpose = `native:${key.role}`;
    const accepted = acceptedByPurpose.get(purpose) ?? new Set<string>();
    accepted.add(agent);
    acceptedByPurpose.set(purpose, accepted);
  }
  const purposes: TrustPolicy['purposes'] = {};
  for (const [purpose, accepted] of acceptedByPurpose) {
    purposes[purpose] = { accepted: [...accepted], requiredStrength: 'strong' };
  }
  const policy: TrustPolicy = {
    protocol: 'https://spec.jinn.network/trust/policy/v1',
    version: 1,
    purposes,
    signerSet: { keys: [policySigner.key.keyId], threshold: 1 },
    refreshBy: '2027-01-01T00:00:00.000Z',
  };
  const sealedPolicy = await sealTrustPolicy(policy, ed25519DsseSigner(policySigner.key));

  const bindingEntries: Array<Record<string, unknown>> = [];
  for (const { key, agent } of input.roleKeys) {
    // eslint-disable-next-line no-await-in-loop -- bounded, deterministic per-role authoring.
    const ceremony = await buildEoaCeremony(input.ceremonyAccount, agent, key.keyId, validFrom);
    const binding: KeyBinding = {
      protocol: 'https://spec.jinn.network/trust/key-binding/v1',
      agent,
      key: { publicKey: key.keyId, keyid: key.keyId, algorithm: 'Ed25519', didKey: key.keyId },
      voucher: { kind: 'account', did: didPkh(CATALOG_CHAIN_ID, input.ceremonyAccount.address), contractAccount: false },
      relationship: 'controls',
      scope: [...scopeForRole(key.role)],
      validFrom,
      ceremony: { type: 'eoa', digest: ceremonyEvidenceDigest(ceremony) },
      strength: 'strong',
      anchors: [{ digest: anchorDigest }],
    };
    // eslint-disable-next-line no-await-in-loop -- bounded, deterministic per-role authoring.
    const sealed = await sealKeyBinding(binding, ed25519DsseSigner(key));
    bindingEntries.push({
      digest: recordDigest(sealed.envelopeBytes),
      envelope: b64(sealed.envelopeBytes),
      ceremony: {
        type: 'eoa',
        message: ceremony.message,
        messageBytes: b64(ceremony.messageBytes),
        signature: b64(ceremony.signature),
      },
    });
  }

  const catalog = {
    schemaVersion: 2,
    format: 'jinn.native-trust-catalog/2',
    policyGenesisDigest: sealedPolicy.recordDigest,
    policies: [{ digest: sealedPolicy.recordDigest, envelope: b64(sealedPolicy.envelopeBytes) }],
    // The strict locator schema carries only these five keys — `anchorTime` is an out-of-band read
    // hint, never part of the on-disk catalog.
    anchors: [{
      digest: anchorDigest,
      locator: {
        profile: ANCHOR_PROFILE,
        chainId: CATALOG_CHAIN_ID,
        transactionHash: locator.transactionHash,
        contractAddress: locator.contractAddress,
        inputByteOffset: locator.inputByteOffset,
      },
    }],
    bindings: bindingEntries,
    revocations: [],
  };
  await writeFile(input.path, JSON.stringify(catalog));

  const authored: AuthoredTrustCatalog = {
    path: input.path,
    policyGenesisDigest: sealedPolicy.recordDigest,
    anchorDigest,
    bootTime: validFrom,
    ...(input.submitAnchor === undefined
      ? {
          mockAnchorClient: {
            async lookupFinalizedAnchor(lookup) {
              if (lookup.digest !== anchorDigest) return null;
              return {
                digest: anchorDigest as `sha256:${string}`,
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
  return authored;
}

export type { Sha256Digest };
