/**
 * The contract of `@jinn-network/trust-authoring` (spec/2026-08-07-native-identity-ceremony.md,
 * PR1): what it authors, the PRODUCTION verifiers accept. Nothing here mocks a trust decision —
 * `openNativeTrustCatalog` and `openRoleIdentitySet` are the shipped daemon code, the ceremony
 * signatures are real EIP-191 signatures from a local viem account, and the only stand-in is the
 * finalized-anchor reader (a chain read, not a trust rung).
 *
 * This is the round-trip the package exists to make true, and it is deliberately NOT written
 * through the e2e fixtures: the fixtures are one consumer, and a test that only exercised them
 * could not distinguish "the package authors production-valid artifacts" from "the fixtures and the
 * package agree with each other".
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anchorDeclaration,
  appendOperator,
  authorCatalog,
  authorRoleBinding,
  completePolicyPurposes,
  isSettlementRole,
  openCatalogAuthority,
  openRoleSigners,
  performEoaCeremony,
  submitAnchor,
  type AnchorDeclaration,
  type CatalogAuthoritySigner,
  type SealedBindingEntry,
} from '@jinn-network/trust-authoring';
import { recordDigest } from '@jinn-network/trust-core';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  openNativeTrustCatalog,
  type NativeFinalizedAnchorReadClient,
} from '../../src/daemon/native-trust-catalog.js';
import {
  openRoleIdentitySet,
  type NativeRoleIdentityRole,
} from '../../src/daemon/role-identities.js';

const PASSWORD = 'trust-authoring-round-trip-password';
const AGENT_A = 'urn:uuid:11111111-1111-4111-8111-111111111111';
const ADMISSION_AGENT_A = 'urn:uuid:11111111-1111-4111-8111-1111111111aa';
const AGENT_B = 'urn:uuid:22222222-2222-4222-8222-222222222222';
const SAFE_A = '0x8464135c8F25Da09e49BC8782676a84730C318bC' as const;
const REFRESH_BY = '2027-02-07T00:00:00.000Z';

const ceremonyAccountA = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const ceremonyAccountB = privateKeyToAccount(`0x${'22'.repeat(32)}`);

/** A stub chain: `submitAnchor` writes calldata and reads the mined block's timestamp. */
function anchorChain(blockSeconds: number) {
  const hash = `0x${blockSeconds.toString(16).padStart(64, '0')}` as `0x${string}`;
  return {
    hash,
    walletClient: { async sendTransaction() { return hash; } },
    publicClient: {
      async waitForTransactionReceipt() { return { blockNumber: BigInt(blockSeconds), status: 'success' }; },
      async getBlock() { return { timestamp: BigInt(blockSeconds) }; },
    },
  };
}

/** The only stand-in: the finalized-anchor read. Every declared anchor reads back finalized. */
function anchorClientFor(
  observations: readonly { digest: `sha256:${string}`; anchorTime: string; transactionHash: `0x${string}` }[],
): NativeFinalizedAnchorReadClient {
  return {
    async lookupFinalizedAnchor({ digest }) {
      const found = observations.find((observation) => observation.digest === digest);
      if (found === undefined) return null;
      return {
        digest: found.digest,
        anchorTime: found.anchorTime,
        chainId: 84532,
        transactionHash: found.transactionHash,
        blockHash: `0x${'ef'.repeat(32)}`,
        blockNumber: 1n,
        finalized: true,
      };
    },
  };
}

async function authorOperator(input: {
  readonly root: string;
  readonly label: string;
  readonly agent: string;
  readonly roles: readonly NativeRoleIdentityRole[];
  readonly account: typeof ceremonyAccountA;
  readonly settlementSafe: `0x${string}`;
  readonly anchorDigest: `sha256:${string}`;
  readonly validFrom: string;
}): Promise<{ readonly storePath: string; readonly bindings: readonly SealedBindingEntry[] }> {
  const storePath = join(input.root, `${input.label}.enc.json`);
  const signers = await openRoleSigners({
    storePath,
    password: PASSWORD,
    ownedRoles: input.roles,
    create: true,
  });
  const bindings: SealedBindingEntry[] = [];
  for (const role of input.roles) {
    const signer = signers.get(role)!;
    const ceremony = await performEoaCeremony({
      signer: input.account,
      agent: input.agent,
      didKey: signer.keyId,
      issuedAt: input.validFrom,
      ...(isSettlementRole(role) ? { settlementSafe: input.settlementSafe } : {}),
    });
    bindings.push(await authorRoleBinding({
      role,
      signer,
      agent: input.agent,
      ceremonyAccount: input.account.address,
      ceremony,
      validFrom: input.validFrom,
      anchorDigest: input.anchorDigest,
    }));
  }
  return { storePath, bindings };
}

interface Genesis {
  readonly root: string;
  readonly catalogPath: string;
  readonly authority: CatalogAuthoritySigner;
  readonly policyGenesisDigest: `sha256:${string}`;
  readonly anchorTime: string;
  readonly anchor: AnchorDeclaration;
  readonly solverStore: string;
  readonly requesterStore: string;
  readonly admissionStore: string;
  readonly bindings: readonly SealedBindingEntry[];
}

async function genesisForOperatorA(): Promise<Genesis> {
  const root = await mkdtemp(join(tmpdir(), 'trust-authoring-round-trip-'));
  const authority = await openCatalogAuthority({
    storePath: join(root, 'authority.enc.json'),
    password: PASSWORD,
    create: true,
  });

  // §6 law 1: anchor FIRST — its block time is the only correct `validFrom`.
  const anchorDigest = recordDigest(new TextEncoder().encode('round-trip-anchor-a'));
  const chain = anchorChain(1_786_000_000);
  const locator = await submitAnchor({
    walletClient: chain.walletClient,
    publicClient: chain.publicClient,
    target: '0x00000000000000000000000000000000000a11c0',
    digest: anchorDigest,
  });

  const solver = await authorOperator({
    root,
    label: 'a-solver',
    agent: AGENT_A,
    roles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
    account: ceremonyAccountA,
    settlementSafe: SAFE_A,
    anchorDigest,
    validFrom: locator.anchorTime,
  });
  const requester = await authorOperator({
    root,
    label: 'a-requester',
    agent: AGENT_A,
    roles: ['requester-submission', 'requester-discovery'],
    account: ceremonyAccountA,
    settlementSafe: SAFE_A,
    anchorDigest,
    validFrom: locator.anchorTime,
  });
  const admission = await authorOperator({
    root,
    label: 'a-admission',
    agent: ADMISSION_AGENT_A,
    roles: ['admission'],
    account: ceremonyAccountA,
    settlementSafe: SAFE_A,
    anchorDigest,
    validFrom: locator.anchorTime,
  });

  const bindings = [...solver.bindings, ...requester.bindings, ...admission.bindings];
  const anchor = anchorDeclaration(anchorDigest, locator);
  const catalogPath = join(root, 'trust.json');
  const { policyGenesisDigest } = await authorCatalog({
    path: catalogPath,
    authority,
    purposes: completePolicyPurposes({
      roleAgents: bindings.map(({ role, agent }) => ({ role, agent })),
      evaluatorAgents: [AGENT_A],
    }),
    refreshBy: REFRESH_BY,
    bindings,
    anchors: [anchor],
  });

  return {
    root,
    catalogPath,
    authority,
    policyGenesisDigest,
    anchorTime: locator.anchorTime,
    anchor,
    solverStore: solver.storePath,
    requesterStore: requester.storePath,
    admissionStore: admission.storePath,
    bindings,
  };
}

describe('@jinn-network/trust-authoring → production verifiers', () => {
  it('authors a catalog and stores the shipped openers accept', async () => {
    const genesis = await genesisForOperatorA();
    const now = new Date(genesis.anchorTime);

    const trust = await openNativeTrustCatalog({
      path: genesis.catalogPath,
      expectedPolicyGenesisDigest: genesis.policyGenesisDigest,
      anchorClient: anchorClientFor([{
        digest: genesis.anchor.digest,
        anchorTime: genesis.anchorTime,
        transactionHash: genesis.anchor.locator.transactionHash,
      }]),
      now,
    });
    expect(trust.newestPolicyVersion).toBe(1);
    expect(trust.conflicts).toEqual([]);

    const solver = await openRoleIdentitySet({
      agent: AGENT_A,
      requiredRoles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
      storePath: genesis.solverStore,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now: () => now,
    });
    expect(solver.get('solver-settlement').keyId.startsWith('did:key:z')).toBe(true);

    const requester = await openRoleIdentitySet({
      agent: AGENT_A,
      requiredRoles: ['requester-submission', 'requester-discovery'],
      storePath: genesis.requesterStore,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now: () => now,
    });
    const admission = await openRoleIdentitySet({
      agent: ADMISSION_AGENT_A,
      requiredRoles: ['admission'],
      storePath: genesis.admissionStore,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now: () => now,
    });
    expect(admission.get('admission').keyId)
      .not.toBe(requester.get('requester-submission').keyId);
  });

  it('carries the complete purpose set §6 law 3 requires, including evaluator-eligibility', async () => {
    const genesis = await genesisForOperatorA();
    const trust = await openNativeTrustCatalog({
      path: genesis.catalogPath,
      expectedPolicyGenesisDigest: genesis.policyGenesisDigest,
      anchorClient: anchorClientFor([{
        digest: genesis.anchor.digest,
        anchorTime: genesis.anchorTime,
        transactionHash: genesis.anchor.locator.transactionHash,
      }]),
      now: new Date(genesis.anchorTime),
    });
    // `policyFor` throws on any absent purpose — these are the entries a hand-authored catalog
    // omits and then fails the evaluator boot on.
    expect(trust.policy('evaluator-eligibility').accepted).toContain(AGENT_A);
    expect(trust.policy('admission-agent').accepted).toContain(ADMISSION_AGENT_A);
    expect(trust.policy('native:admission').accepted).toContain(ADMISSION_AGENT_A);
    expect(trust.policy('native:solver-delivery').accepted).toContain(AGENT_A);
  });

  it('binds validFrom to the verbatim anchor-time string submitAnchor returned', async () => {
    const genesis = await genesisForOperatorA();
    for (const binding of genesis.bindings) {
      expect(binding.validFrom).toBe(genesis.anchorTime);
      expect(binding.ceremony.message.issuedAt).toBe(genesis.anchorTime);
    }
    // `effectiveStart = max(validFrom, anchorTime)` is that exact instant, so a boot one
    // millisecond earlier is refused and a boot at the instant itself is admitted. That pair is
    // what makes the verbatim string load-bearing rather than decorative.
    const trust = await openNativeTrustCatalog({
      path: genesis.catalogPath,
      expectedPolicyGenesisDigest: genesis.policyGenesisDigest,
      anchorClient: anchorClientFor([{
        digest: genesis.anchor.digest,
        anchorTime: genesis.anchorTime,
        transactionHash: genesis.anchor.locator.transactionHash,
      }]),
      now: new Date(genesis.anchorTime),
    });
    const roles: readonly NativeRoleIdentityRole[] = ['solver-delivery', 'solver-settlement', 'solver-discovery'];
    const openAt = (at: Date) => openRoleIdentitySet({
      agent: AGENT_A,
      requiredRoles: roles,
      storePath: genesis.solverStore,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now: () => at,
    });
    await expect(openAt(new Date(new Date(genesis.anchorTime).getTime() - 1)))
      .rejects.toThrow(/no effective binding at boot|not effective at boot/u);
    await expect(openAt(new Date(genesis.anchorTime))).resolves.toBeDefined();
  });

  it('re-opening custody returns the SAME keys, so an authored catalog keeps resolving them', async () => {
    const genesis = await genesisForOperatorA();
    const now = new Date(genesis.anchorTime);
    const reopened = await openRoleSigners({
      storePath: genesis.solverStore,
      password: PASSWORD,
      ownedRoles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
      create: true,
    });
    const boundKeyIds = new Set(genesis.bindings.map(({ keyId }) => keyId));
    for (const signer of reopened.values()) expect(boundKeyIds.has(signer.keyId)).toBe(true);

    const trust = await openNativeTrustCatalog({
      path: genesis.catalogPath,
      expectedPolicyGenesisDigest: genesis.policyGenesisDigest,
      anchorClient: anchorClientFor([{
        digest: genesis.anchor.digest,
        anchorTime: genesis.anchorTime,
        transactionHash: genesis.anchor.locator.transactionHash,
      }]),
      now,
    });
    const solver = await openRoleIdentitySet({
      agent: AGENT_A,
      requiredRoles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
      storePath: genesis.solverStore,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now: () => now,
    });
    expect(solver.get('solver-delivery').keyId)
      .toBe(reopened.get('solver-delivery')!.keyId);
  });

  it('appendOperator lets a joiner boot without disturbing the incumbent or the genesis pin', async () => {
    const genesis = await genesisForOperatorA();

    // B's own session: its own anchor, its own EOA, its own IRIs.
    const bAnchorDigest = recordDigest(new TextEncoder().encode('round-trip-anchor-b'));
    const bChain = anchorChain(1_786_100_000);
    const bLocator = await submitAnchor({
      walletClient: bChain.walletClient,
      publicClient: bChain.publicClient,
      target: '0x00000000000000000000000000000000000a11c0',
      digest: bAnchorDigest,
    });
    const b = await authorOperator({
      root: genesis.root,
      label: 'b-solver',
      agent: AGENT_B,
      roles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
      account: ceremonyAccountB,
      settlementSafe: SAFE_A,
      anchorDigest: bAnchorDigest,
      validFrom: bLocator.anchorTime,
    });

    const joined = await appendOperator({
      catalogPath: genesis.catalogPath,
      authority: genesis.authority,
      newBindings: b.bindings,
      newAnchor: anchorDeclaration(bAnchorDigest, bLocator),
      refreshBy: REFRESH_BY,
    });
    expect(joined.newestPolicyVersion).toBe(2);
    // The genesis digest never moves, so operator A's pinned config stays valid across the join.
    expect(joined.policyGenesisDigest).toBe(genesis.policyGenesisDigest);

    const anchorClient = anchorClientFor([
      { digest: genesis.anchor.digest, anchorTime: genesis.anchorTime, transactionHash: genesis.anchor.locator.transactionHash },
      { digest: bAnchorDigest, anchorTime: bLocator.anchorTime, transactionHash: bLocator.transactionHash },
    ]);
    const now = new Date(bLocator.anchorTime);
    const trust = await openNativeTrustCatalog({
      path: genesis.catalogPath,
      // A's UNCHANGED pin still opens the rewritten catalog.
      expectedPolicyGenesisDigest: genesis.policyGenesisDigest,
      anchorClient,
      now,
    });
    expect(trust.newestPolicyVersion).toBe(2);
    expect(trust.conflicts).toEqual([]);

    // §7.4a per-agent: the joiner's fresh Agent IRI gets its own genesis binding, so nothing of A's
    // stands in its way — and A's own roles still boot off the same file.
    const bSolver = await openRoleIdentitySet({
      agent: AGENT_B,
      requiredRoles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
      storePath: b.storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now: () => now,
    });
    const aSolver = await openRoleIdentitySet({
      agent: AGENT_A,
      requiredRoles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
      storePath: genesis.solverStore,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now: () => now,
    });
    expect(bSolver.get('solver-delivery').keyId).not.toBe(aSolver.get('solver-delivery').keyId);

    // The successor extends `accepted` rather than replacing it.
    expect(trust.policy('native:solver-delivery').accepted).toEqual(
      expect.arrayContaining([AGENT_A, AGENT_B]),
    );
    expect(trust.policy('native:admission').accepted).toContain(ADMISSION_AGENT_A);
    expect(trust.policy('evaluator-eligibility').accepted).toContain(AGENT_A);
  });
});
