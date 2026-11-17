/**
 * Rotation over a real catalog (#5236): what `@jinn-network/trust-authoring`'s rebind and
 * revocation author, the PRODUCTION readers act on. `openNativeTrustCatalog` and
 * `openRoleIdentitySet` are the shipped daemon code, the ceremony and revocation signatures are real
 * EIP-191 signatures from a local viem account, and the only stand-ins are the chain reads: the
 * finalized-anchor reader and the Safe-ownership read.
 *
 * The flow is the one `jinn ceremony rotate` runs: a new store for the role family, its replacement
 * bindings under a fresh anchor (`rebindRoles`), then the voucher account's revocation of the
 * retired bindings under the act's `revocation-anchor/v1` anchor (`planRevocation`, `revokeBinding`).
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anchorDeclaration,
  authorCatalog,
  authorRoleBinding,
  completePolicyPurposes,
  isSettlementRole,
  openCatalogAuthority,
  openRoleSigners,
  performEoaCeremony,
  planRevocation,
  rebindRoles,
  revokeBinding,
  roleBindingTerms,
  submitAnchor,
  type AnchorDeclaration,
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

const PASSWORD = 'trust-rotation-round-trip-password';
const AGENT = 'urn:uuid:51515151-5151-4151-8151-515151515151';
const ADMISSION_AGENT = 'urn:uuid:51515151-5151-4151-8151-5151515151aa';
const SAFE = '0x8464135c8F25Da09e49BC8782676a84730C318bC' as const;
const REFRESH_BY = '2027-02-07T00:00:00.000Z';
const ANCHOR_TARGET = '0x00000000000000000000000000000000000a11c0' as const;

const SOLVER_ROLES: readonly NativeRoleIdentityRole[] = ['solver-delivery', 'solver-settlement', 'solver-discovery'];
const REQUESTER_ROLES: readonly NativeRoleIdentityRole[] = ['requester-submission', 'requester-discovery'];
const ADMISSION_ROLES: readonly NativeRoleIdentityRole[] = ['admission'];

const ceremonyAccount = privateKeyToAccount(`0x${'51'.repeat(32)}`);

interface MinedAnchor {
  readonly declaration: AnchorDeclaration;
  readonly anchorTime: string;
}

/** A stub chain: `submitAnchor` writes the calldata and reads back the mined block's timestamp. */
async function mine(digest: `sha256:${string}`, blockSeconds: number): Promise<MinedAnchor> {
  const hash = `0x${blockSeconds.toString(16).padStart(64, '0')}` as `0x${string}`;
  const locator = await submitAnchor({
    walletClient: { async sendTransaction() { return hash; } },
    publicClient: {
      async waitForTransactionReceipt() { return { blockNumber: BigInt(blockSeconds), status: 'success' }; },
      async getBlock() { return { timestamp: BigInt(blockSeconds) }; },
    },
    target: ANCHOR_TARGET,
    digest,
  });
  return { declaration: anchorDeclaration(digest, locator), anchorTime: locator.anchorTime };
}

/** Every declared anchor reads back finalized at the time it was mined. */
function anchorClientFor(anchors: readonly MinedAnchor[]): NativeFinalizedAnchorReadClient {
  return {
    async lookupFinalizedAnchor({ digest }) {
      const found = anchors.find((anchor) => anchor.declaration.digest === digest);
      if (found === undefined) return null;
      return {
        digest,
        anchorTime: found.anchorTime,
        chainId: 84532,
        transactionHash: found.declaration.locator.transactionHash,
        blockHash: `0x${'ef'.repeat(32)}`,
        blockNumber: 1n,
        finalized: true,
      };
    },
  };
}

/** One role family's custody and its bindings, authored exactly as `jinn ceremony` authors them. */
async function authorFamily(input: {
  readonly storePath: string;
  readonly agent: string;
  readonly roles: readonly NativeRoleIdentityRole[];
  readonly anchor: MinedAnchor;
}): Promise<readonly SealedBindingEntry[]> {
  const signers = await openRoleSigners({
    storePath: input.storePath,
    password: PASSWORD,
    ownedRoles: input.roles,
    create: true,
  });
  const validFrom = input.anchor.anchorTime;
  const bindings: SealedBindingEntry[] = [];
  for (const role of input.roles) {
    const signer = signers.get(role)!;
    const ceremony = await performEoaCeremony({
      signer: ceremonyAccount,
      agent: input.agent,
      didKey: signer.keyId,
      issuedAt: validFrom,
      terms: roleBindingTerms(role, validFrom),
      ...(isSettlementRole(role) ? { settlementSafe: SAFE } : {}),
    });
    bindings.push(await authorRoleBinding({
      role,
      signer,
      agent: input.agent,
      ceremonyAccount: ceremonyAccount.address,
      ceremony,
      validFrom,
      anchorDigest: input.anchor.declaration.digest,
    }));
  }
  return bindings;
}

interface Operator {
  readonly root: string;
  readonly catalogPath: string;
  readonly policyGenesisDigest: `sha256:${string}`;
  readonly anchors: MinedAnchor[];
  readonly stores: Record<'solver' | 'requester' | 'admission', string>;
  readonly bindings: readonly SealedBindingEntry[];
}

async function genesis(): Promise<Operator> {
  const root = await mkdtemp(join(tmpdir(), 'trust-rotation-round-trip-'));
  const anchor = await mine(recordDigest(new TextEncoder().encode('rotation-genesis-anchor')), 1_786_000_000);
  const stores = {
    solver: join(root, 'identity', 'solver.enc.json'),
    requester: join(root, 'identity', 'requester.enc.json'),
    admission: join(root, 'identity', 'admission.enc.json'),
  };
  const bindings = [
    ...await authorFamily({ storePath: stores.solver, agent: AGENT, roles: SOLVER_ROLES, anchor }),
    ...await authorFamily({ storePath: stores.requester, agent: AGENT, roles: REQUESTER_ROLES, anchor }),
    ...await authorFamily({ storePath: stores.admission, agent: ADMISSION_AGENT, roles: ADMISSION_ROLES, anchor }),
  ];
  const catalogPath = join(root, 'trust.json');
  const { policyGenesisDigest } = await authorCatalog({
    path: catalogPath,
    authority: await openCatalogAuthority({ storePath: join(root, 'authority.enc.json'), password: PASSWORD, create: true }),
    purposes: completePolicyPurposes({
      roleAgents: bindings.map(({ role, agent }) => ({ role, agent })),
      evaluatorAgents: [AGENT],
    }),
    refreshBy: REFRESH_BY,
    bindings,
    anchors: [anchor.declaration],
  });
  return { root, catalogPath, policyGenesisDigest, anchors: [anchor], stores, bindings };
}

/** The rebind half: a NEW store for the family and its replacement bindings under a fresh anchor. */
async function rebind(operator: Operator, input: {
  readonly family: 'solver' | 'admission';
  readonly agent: string;
  readonly roles: readonly NativeRoleIdentityRole[];
  readonly blockSeconds: number;
}): Promise<{ readonly storePath: string; readonly replacements: readonly SealedBindingEntry[]; readonly at: string }> {
  const storePath = join(operator.root, 'identity', `${input.family}.rotated.enc.json`);
  const anchor = await mine(recordDigest(new TextEncoder().encode(`rotation-rebind-${input.family}`)), input.blockSeconds);
  const replacements = await authorFamily({ storePath, agent: input.agent, roles: input.roles, anchor });
  await rebindRoles({ catalogPath: operator.catalogPath, replacements, anchor: anchor.declaration });
  operator.anchors.push(anchor);
  return { storePath, replacements, at: anchor.anchorTime };
}

/** The revocation half: one act, by the voucher account, under its `revocation-anchor/v1` anchor. */
async function revoke(operator: Operator, input: {
  readonly targets: readonly `sha256:${string}`[];
  readonly blockSeconds: number;
}): Promise<string> {
  const plan = await planRevocation({ catalogPath: operator.catalogPath, voucher: ceremonyAccount, targets: input.targets });
  const anchor = await mine(plan.anchorDigest, input.blockSeconds);
  await revokeBinding({
    catalogPath: operator.catalogPath,
    voucher: ceremonyAccount,
    targets: input.targets,
    effectiveTime: anchor.anchorTime,
    anchor: anchor.declaration,
  });
  operator.anchors.push(anchor);
  return anchor.anchorTime;
}

async function open(operator: Operator, now: string) {
  return openNativeTrustCatalog({
    path: operator.catalogPath,
    expectedPolicyGenesisDigest: operator.policyGenesisDigest,
    anchorClient: anchorClientFor(operator.anchors),
    settlementOwnershipClient: {
      async isOwner(safe: `0x${string}`, owner: `0x${string}`) {
        return safe.toLowerCase() === SAFE.toLowerCase() && owner.toLowerCase() === ceremonyAccount.address.toLowerCase();
      },
    },
    now: new Date(now),
  });
}

function bindingsOf(bindings: readonly SealedBindingEntry[], roles: readonly NativeRoleIdentityRole[]) {
  return bindings.filter(({ role }) => roles.includes(role));
}

describe('a rotated role key over a real catalog (#5236)', () => {
  it('resolves the successor and refuses the retired key from the revocation on, not before', async () => {
    const operator = await genesis();
    const retired = bindingsOf(operator.bindings, SOLVER_ROLES);
    const successor = await rebind(operator, { family: 'solver', agent: AGENT, roles: SOLVER_ROLES, blockSeconds: 1_786_000_600 });
    const revokedAt = await revoke(operator, { targets: retired.map(({ digest }) => digest), blockSeconds: 1_786_001_200 });
    const trust = await open(operator, revokedAt);
    const openAt = (storePath: string, at: string) => openRoleIdentitySet({
      agent: AGENT,
      requiredRoles: SOLVER_ROLES,
      storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      revocationAuthority: trust,
      verifyRoleBinding: trust.verifyRoleBinding,
      now: () => new Date(at),
    });
    const retiredDelivery = retired.find(({ role }) => role === 'solver-delivery')!;
    const successorDelivery = successor.replacements.find(({ role }) => role === 'solver-delivery')!;

    // The retired store no longer boots, and its key is refused from the revocation's effective time.
    await expect(openAt(operator.stores.solver, revokedAt)).rejects.toThrow(/binding is revoked at boot/u);
    const before = await openAt(operator.stores.solver, successor.at);
    await expect(before.resolveEffective('solver-delivery', successor.at)).resolves.toMatchObject({ ok: true });
    await expect(before.resolveEffective('solver-delivery', revokedAt)).resolves.toEqual({ ok: false, reason: 'revoked' });
    await expect(trust.verifyRoleBinding({
      role: 'solver-delivery', key: retiredDelivery.keyId, agent: AGENT, family: 'deliveries', atTime: revokedAt,
    })).rejects.toThrow(/revoked/u);
    // Not retroactive: what the retired key signed before the revocation still verifies.
    await expect(trust.verifyRoleBinding({
      role: 'solver-delivery', key: retiredDelivery.keyId, agent: AGENT, family: 'deliveries', atTime: successor.at,
    })).resolves.toMatchObject({ bindingDigest: retiredDelivery.digest });

    // The successor store boots, and every successor key resolves and verifies.
    const rotated = await openAt(successor.storePath, revokedAt);
    for (const role of SOLVER_ROLES) {
      await expect(rotated.resolveEffective(role, revokedAt)).resolves.toMatchObject({ ok: true });
    }
    await expect(trust.verifyRoleBinding({
      role: 'solver-delivery', key: successorDelivery.keyId, agent: AGENT, family: 'deliveries', atTime: revokedAt,
    })).resolves.toEqual({ bindingDigest: successorDelivery.digest });

    // The Agent's other roles are untouched.
    const requesterSubmission = operator.bindings.find(({ role }) => role === 'requester-submission')!;
    await expect(trust.verifyRoleBinding({
      role: 'requester-submission', key: requesterSubmission.keyId, agent: AGENT, family: 'authorizations', atTime: revokedAt,
    })).resolves.toEqual({ bindingDigest: requesterSubmission.digest });
  });

  it('rotates the admission key, whose Agent holds no other binding, when the rebind comes first', async () => {
    const operator = await genesis();
    const [retired] = bindingsOf(operator.bindings, ADMISSION_ROLES);
    const successor = await rebind(operator, {
      family: 'admission', agent: ADMISSION_AGENT, roles: ADMISSION_ROLES, blockSeconds: 1_786_000_600,
    });
    const revokedAt = await revoke(operator, { targets: [retired!.digest], blockSeconds: 1_786_001_200 });
    const trust = await open(operator, revokedAt);

    await expect(trust.verifyRoleBinding({
      role: 'admission', key: retired!.keyId, agent: ADMISSION_AGENT, family: 'https://spec.jinn.network/trust-scopes/admission-receipts/v1', atTime: revokedAt,
    })).rejects.toThrow(/revoked/u);
    // The successor drew its authority from the retired binding while it still stood, and a later
    // revocation of that authority takes nothing back (key authority section 6).
    await expect(trust.verifyRoleBinding({
      role: 'admission', key: successor.replacements[0]!.keyId, agent: ADMISSION_AGENT, family: 'https://spec.jinn.network/trust-scopes/admission-receipts/v1', atTime: revokedAt,
    })).resolves.toEqual({ bindingDigest: successor.replacements[0]!.digest });
  });

  it('refuses a rebind after the revocation, and a verifier refuses the successor the guard would have stopped', async () => {
    const operator = await genesis();
    const [retired] = bindingsOf(operator.bindings, ADMISSION_ROLES);
    const revokedAt = await revoke(operator, { targets: [retired!.digest], blockSeconds: 1_786_000_600 });
    await expect(rebind(operator, {
      family: 'admission', agent: ADMISSION_AGENT, roles: ADMISSION_ROLES, blockSeconds: 1_786_001_200,
    })).rejects.toThrow(/rebind before revoking/u);

    // The same successor written past the guard: its chain has no standing authority.
    const late = await mine(recordDigest(new TextEncoder().encode('rotation-late-rebind')), 1_786_001_800);
    const [replacement] = await authorFamily({
      storePath: join(operator.root, 'identity', 'admission.late.enc.json'),
      agent: ADMISSION_AGENT,
      roles: ADMISSION_ROLES,
      anchor: late,
    });
    const catalog = JSON.parse(await readFile(operator.catalogPath, 'utf8')) as { anchors: unknown[]; bindings: unknown[] };
    catalog.anchors.push(late.declaration);
    catalog.bindings.push({
      digest: replacement!.digest,
      envelope: Buffer.from(replacement!.envelopeBytes).toString('base64'),
      ceremony: {
        type: 'eoa',
        message: replacement!.ceremony.message,
        messageBytes: Buffer.from(replacement!.ceremony.messageBytes).toString('base64'),
        signature: Buffer.from(replacement!.ceremony.signature).toString('base64'),
      },
    });
    await writeFile(operator.catalogPath, JSON.stringify(catalog));
    operator.anchors.push(late);
    const trust = await open(operator, late.anchorTime);
    expect(revokedAt < late.anchorTime).toBe(true);
    await expect(trust.verifyRoleBinding({
      role: 'admission', key: replacement!.keyId, agent: ADMISSION_AGENT, family: 'https://spec.jinn.network/trust-scopes/admission-receipts/v1', atTime: late.anchorTime,
    })).rejects.toThrow(/consent-chain-violation/u);
  });
});
