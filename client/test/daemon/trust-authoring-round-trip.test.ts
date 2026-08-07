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
  NATIVE_ROLE_IDENTITY_REQUIREMENTS,
  NATIVE_ROLE_IDENTITY_ROLES,
  type AnchorDeclaration,
  type CatalogAuthoritySigner,
  type RoleSigner,
  type SealedBindingEntry,
} from '@jinn-network/trust-authoring';
import { dssePreAuthEncoding, recordDigest } from '@jinn-network/trust-core';
import { createTrustAdapter } from '@jinn-network/record-discovery-client';
import { MEDIA_HEAD, sealJson } from '@jinn-network/record-discovery-protocol';
import { DISCOVERY_SIGNING_SCOPE } from '@jinn-network/record-discovery-protocol';
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

/**
 * The second stand-in: the §2.3c step-5 Safe-ownership read. `SAFE_A` is a plain address here (no
 * chain in this suite), so this answers the question a deployed Safe would: does it own that EOA.
 */
function ownershipFor(safe: `0x${string}`, owners: readonly `0x${string}`[]) {
  return {
    async isOwner(candidate: `0x${string}`, signer: `0x${string}`) {
      return candidate.toLowerCase() === safe.toLowerCase()
        && owners.some((owner) => owner.toLowerCase() === signer.toLowerCase());
    },
  };
}

/** The only other stand-in: the finalized-anchor read. Every declared anchor reads back finalized. */
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

/** The `scope` array inside a sealed KeyBinding envelope, read back off the authored bytes. */
function decodeBindingScope(envelopeBytes: Uint8Array): readonly string[] {
  const envelope = JSON.parse(new TextDecoder().decode(envelopeBytes)) as { payload: string };
  const payload = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as { scope: string[] };
  return payload.scope;
}

/**
 * The two-operator catalog every test in the discovery block shares: A (requester + solver +
 * admission role sets) joined by B (solver role set), exactly as `appendOperator` composes them.
 * Returns the opened production authority plus the authored bindings, so a test can assert on what
 * the ceremony actually minted rather than on a restatement of it.
 */
async function twoOperatorCatalog(): Promise<{
  readonly trust: Awaited<ReturnType<typeof openNativeTrustCatalog>>;
  readonly now: Date;
  readonly bindings: readonly SealedBindingEntry[];
  signerFor(agent: string, role: NativeRoleIdentityRole): RoleSigner;
  discoveryKeyIdsFor(agent: string): readonly string[];
}> {
  const genesis = await genesisForOperatorA();
  const bAnchorDigest = recordDigest(new TextEncoder().encode('discovery-anchor-b'));
  const bChain = anchorChain(1_786_100_000);
  const bLocator = await submitAnchor({
    walletClient: bChain.walletClient,
    publicClient: bChain.publicClient,
    target: '0x00000000000000000000000000000000000a11c0',
    digest: bAnchorDigest,
  });
  const b = await authorOperator({
    root: genesis.root,
    label: 'b-discovery-solver',
    agent: AGENT_B,
    roles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
    account: ceremonyAccountB,
    settlementSafe: SAFE_A,
    anchorDigest: bAnchorDigest,
    validFrom: bLocator.anchorTime,
  });
  await appendOperator({
    catalogPath: genesis.catalogPath,
    authority: genesis.authority,
    newBindings: b.bindings,
    newAnchor: anchorDeclaration(bAnchorDigest, bLocator),
    refreshBy: REFRESH_BY,
  });

  const now = new Date(bLocator.anchorTime);
  const trust = await openNativeTrustCatalog({
    path: genesis.catalogPath,
    expectedPolicyGenesisDigest: genesis.policyGenesisDigest,
    anchorClient: anchorClientFor([
      { digest: genesis.anchor.digest, anchorTime: genesis.anchorTime, transactionHash: genesis.anchor.locator.transactionHash },
      { digest: bAnchorDigest, anchorTime: bLocator.anchorTime, transactionHash: bLocator.transactionHash },
    ]),
    settlementOwnershipClient: ownershipFor(SAFE_A, [ceremonyAccountA.address, ceremonyAccountB.address]),
    now,
  });
  const bindings = [...genesis.bindings, ...b.bindings];
  const stores: Record<string, string> = {
    [`${AGENT_A}:requester-submission`]: genesis.requesterStore,
    [`${AGENT_A}:requester-discovery`]: genesis.requesterStore,
    [`${AGENT_A}:solver-discovery`]: genesis.solverStore,
    [`${AGENT_B}:solver-discovery`]: b.storePath,
  };
  const signers = new Map<string, RoleSigner>();
  for (const [key, storePath] of Object.entries(stores)) {
    const role = key.slice(key.lastIndexOf(':') + 1) as NativeRoleIdentityRole;
    const ownedRoles = storePath === genesis.requesterStore
      ? (['requester-submission', 'requester-discovery'] as const)
      : (['solver-delivery', 'solver-settlement', 'solver-discovery'] as const);
    // eslint-disable-next-line no-await-in-loop -- four small encrypted stores.
    const opened = await openRoleSigners({ storePath, password: PASSWORD, ownedRoles: [...ownedRoles], create: false });
    signers.set(key, opened.get(role)!);
  }

  return {
    trust,
    now,
    bindings,
    signerFor(agent, role) {
      const signer = signers.get(`${agent}:${role}`);
      if (signer === undefined) throw new Error(`no test signer for ${agent}/${role}`);
      return signer;
    },
    discoveryKeyIdsFor(agent) {
      return bindings.filter((binding) => binding.agent === agent && binding.role.endsWith('-discovery'))
        .map(({ keyId }) => keyId);
    },
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
      settlementOwnershipClient: ownershipFor(SAFE_A, [ceremonyAccountA.address, ceremonyAccountB.address]),
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

    // §2.3c: the settlement ceremony this package authored carries its Safe as the third resource,
    // and the production check accepts it — the whole point of the amendment, since the Safe itself
    // could never have signed the ceremony that names it.
    await expect(trust.verifyOnchainAuthority({
      key: solver.get('solver-settlement').keyId,
      agent: AGENT_A,
      address: SAFE_A,
      atTime: genesis.anchorTime,
      purpose: 'native:solver-settlement',
    })).resolves.toMatchObject({ bindingDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) });
    // A DIFFERENT Safe is refused even though the binding itself verifies.
    await expect(trust.verifyOnchainAuthority({
      key: solver.get('solver-settlement').keyId,
      agent: AGENT_A,
      address: '0x000000000000000000000000000000000000dEaD',
      atTime: genesis.anchorTime,
      purpose: 'native:solver-settlement',
    })).rejects.toThrow(/declares settlement resource/u);

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
      settlementOwnershipClient: ownershipFor(SAFE_A, [ceremonyAccountA.address, ceremonyAccountB.address]),
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
      settlementOwnershipClient: ownershipFor(SAFE_A, [ceremonyAccountA.address, ceremonyAccountB.address]),
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
      settlementOwnershipClient: ownershipFor(SAFE_A, [ceremonyAccountA.address, ceremonyAccountB.address]),
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
      settlementOwnershipClient: ownershipFor(SAFE_A, [ceremonyAccountA.address, ceremonyAccountB.address]),
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

/**
 * The poll-time discovery leg, cross-operator, over a REAL authored catalog (issue #2525).
 *
 * This is the test whose absence hid the whole leg-3 failure. `native-fleet-two-operator-boot.ts`
 * says outright that its trust double only exercises `resolverFor` and that "the verifier ports it
 * hands to `createTrustAdapter` are exercised at POLL, which this file does not reach" — so nothing
 * in-tree ever drove `KeyResolver.resolve` against a catalog the ceremony actually mints. Both
 * defects lived in exactly that gap:
 *
 *  - the family-scoped resolver THREW on the first out-of-scope candidate, aborting enumeration;
 *  - and the ceremony minted discovery keys without the announce-plane scope the discovery client
 *    filters on, so even after enumeration completed it resolved to zero keys.
 *
 * Everything below runs through production code: `@jinn-network/trust-authoring` authors the
 * catalog, the shipped `openNativeTrustCatalog` opens it, and the adapter is built exactly as
 * `native-discovery-trust.ts` builds it.
 */
describe('cross-operator discovery key resolution over a real catalog (#2525)', () => {
  /** Built the same way `native-discovery-trust.ts` and `native-consumer/driver.ts` build it. */
  function consumerAdapter(trust: Awaited<ReturnType<typeof openNativeTrustCatalog>>, role: string) {
    return createTrustAdapter({
      bindingResolver: trust.resolverFor({ family: 'observations', purpose: `native:${role}-discovery` }),
      keyCatalog: { candidateKeys: async (agent: string) => [...trust.candidateKeys(agent)] },
      verifier: trust.rawSignatureVerifier,
    });
  }

  it('mints the announce-plane scope on every discovery role, and only those', async () => {
    for (const role of NATIVE_ROLE_IDENTITY_ROLES) {
      const scope = NATIVE_ROLE_IDENTITY_REQUIREMENTS[role];
      expect(scope.includes(DISCOVERY_SIGNING_SCOPE)).toBe(role.endsWith('-discovery'));
    }
    // The discovery client will not treat a key as an announcement signer unless its BINDING says
    // so, so the authored binding — not just the requirements table — has to carry it.
    const genesis = await genesisForOperatorA();
    const discoveryBindings = genesis.bindings.filter(({ role }) => role.endsWith('-discovery'));
    expect(discoveryBindings.length).toBeGreaterThan(0);
    for (const binding of discoveryBindings) {
      const scope = decodeBindingScope(binding.envelopeBytes);
      expect(scope).toContain('observations');
      expect(scope).toContain(DISCOVERY_SIGNING_SCOPE);
    }
  });

  it('resolves the observations key for a multi-family agent regardless of catalog order', async () => {
    const { trust, now, bindings, discoveryKeyIdsFor } = await twoOperatorCatalog();

    // The premise, asserted rather than assumed: A's FIRST catalog candidate is NOT a discovery
    // key, and its scope covers neither `observations` nor the announce plane. Enumeration must
    // therefore walk past at least one out-of-scope candidate to reach a usable one — which is
    // exactly what the old throw made impossible, on candidate #1, for every multi-scope agent.
    // (The live gate's catalog led with an `authorizations` key; this fixture leads with
    // `deliveries`. The property that matters is the same either way, so it is the property that
    // is pinned rather than whichever role a given authoring order happens to emit first.)
    const candidates = trust.candidateKeys(AGENT_A).map(({ keyid }) => keyid);
    const discoveryIds = new Set(discoveryKeyIdsFor(AGENT_A));
    const firstScope = decodeBindingScope(bindings.find(({ keyId }) => keyId === candidates[0])!.envelopeBytes);
    expect(discoveryIds.has(candidates[0]!)).toBe(false);
    expect(firstScope).not.toContain('observations');
    expect(firstScope).not.toContain(DISCOVERY_SIGNING_SCOPE);
    expect(candidates.length).toBeGreaterThan(3);

    // B's consumer, resolving A. No throw, and it finds A's discovery keys past the ones it skipped.
    const resolved = await consumerAdapter(trust, 'requester').keys.resolve(AGENT_A, now);
    const resolvedIds = resolved.map(({ keyid }) => keyid).sort();
    const expectedIds = [...new Set(discoveryKeyIdsFor(AGENT_A))].sort();
    expect(resolvedIds).toEqual(expectedIds);
    expect(resolvedIds).not.toContain(candidates[0]);

    // Symmetric: A's consumer resolving B.
    const resolvedB = await consumerAdapter(trust, 'solver').keys.resolve(AGENT_B, now);
    expect(resolvedB.map(({ keyid }) => keyid).sort())
      .toEqual([...new Set(discoveryKeyIdsFor(AGENT_B))].sort());
  });

  it('verifies a head one operator signed with the key the other operator resolved', async () => {
    const { trust, now, signerFor } = await twoOperatorCatalog();
    const signer = signerFor(AGENT_A, 'requester-discovery');
    const adapter = consumerAdapter(trust, 'requester');

    // A signs a head; B resolves A's keys and checks the signature against the resolved key. This
    // is the end of the chain the live gate never reached.
    const headBytes = sealJson({ source: { agent: AGENT_A, name: 'native-requester' }, sequence: '1' }).bytes;
    const pae = dssePreAuthEncoding(MEDIA_HEAD, headBytes);
    const [signature] = await signer.dsseSigner({ preAuthEncoding: pae, payloadType: MEDIA_HEAD, payloadBytes: headBytes });

    const key = (await adapter.keys.resolve(AGENT_A, now)).find(({ keyid }) => keyid === signer.keyId);
    expect(key).toBeDefined();
    await expect(adapter.sigs.verify(pae, signature.signature, key!)).resolves.toBe(true);

    // A tampered signature is still rejected — resolving the key is not accepting the bytes.
    const tampered = new Uint8Array(signature.signature);
    tampered[0] ^= 0xff;
    await expect(adapter.sigs.verify(pae, tampered, key!)).resolves.toBe(false);
    // And a head signed by A's AUTHORIZATIONS key resolves to no usable key at all.
    const wrongRole = signerFor(AGENT_A, 'requester-submission');
    expect((await adapter.keys.resolve(AGENT_A, now)).some(({ keyid }) => keyid === wrongRole.keyId)).toBe(false);
  });

  it('still refuses an agent whose bindings the catalog does not carry', async () => {
    const { trust, now } = await twoOperatorCatalog();
    await expect(consumerAdapter(trust, 'requester').keys.resolve('urn:uuid:00000000-0000-4000-8000-000000000000', now))
      .resolves.toEqual([]);
  });
});
