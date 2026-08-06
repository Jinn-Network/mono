/**
 * Keystone unit coverage for the native-fleet e2e fixtures (one-swap M7, umbrella #2461).
 *
 * Proves the two hardest boot-critical legs DETERMINISTICALLY, off-chain (mock anchor client):
 *   1. the fixture identity store round-trips through the production `RoleIdentitySet.open`, and
 *   2. the fixture trust catalog opens through the production `openNativeTrustCatalog` and resolves
 *      every minted role key's effective-time binding.
 * If these pass, the only thing the fork rig adds is REAL finalized anchors + the marketplace legs —
 * the identity/trust boot itself is proven here without a chain.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { openNativeTrustCatalog } from '../../src/daemon/native-trust-catalog.js';
import { openRoleIdentitySet } from '../../src/daemon/role-identities.js';
import { mintIdentityStore } from '../e2e/fixtures/native-fleet/identity.js';
import { authorNativeTrustCatalog, type OwnedRoleKey } from '../e2e/fixtures/native-fleet/trust-catalog.js';
import { buildTwoOperatorNativeSetup } from '../e2e/fixtures/native-fleet/config.js';
import { LaunchedSolverNetRecordSchema } from '../../src/solvernets/store.js';

const PASSWORD = 'native-e2e-fixture-password';
const AGENT = 'urn:jinn:operator:fleet-e2e-a';
const ADMISSION_AGENT = 'urn:jinn:admission:fleet-e2e-a';
const NOW = new Date('2026-08-02T00:00:00.000Z');
const CEREMONY_ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

describe('native-fleet fixtures — identity + trust boot leg', () => {
  it('mints identity stores + a catalog the production loaders accept', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-fleet-fixture-'));
    const solverStore = await mintIdentityStore({
      storePath: join(root, 'solver.enc.json'),
      password: PASSWORD,
      roles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
    });
    const requesterStore = await mintIdentityStore({
      storePath: join(root, 'requester.enc.json'),
      password: PASSWORD,
      roles: ['requester-submission', 'requester-discovery'],
    });
    const admissionStore = await mintIdentityStore({
      storePath: join(root, 'admission.enc.json'),
      password: PASSWORD,
      roles: ['admission'],
    });

    const roleKeys: OwnedRoleKey[] = [
      ...solverStore.keys.map((key) => ({ key, agent: AGENT })),
      ...requesterStore.keys.map((key) => ({ key, agent: AGENT })),
      { key: admissionStore.key('admission'), agent: ADMISSION_AGENT },
    ];
    const authored = await authorNativeTrustCatalog({
      path: join(root, 'trust.json'),
      roleKeys,
      ceremonyAccount: CEREMONY_ACCOUNT,
    });
    expect(authored.mockAnchorClient).toBeDefined();

    const trust = await openNativeTrustCatalog({
      path: authored.path,
      expectedPolicyGenesisDigest: authored.policyGenesisDigest,
      anchorClient: authored.mockAnchorClient!,
      now: NOW,
    });

    // Every minted role key resolves its own effective-time binding through the production loader.
    const solverSet = await openRoleIdentitySet({
      agent: AGENT,
      requiredRoles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
      storePath: solverStore.storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now: () => NOW,
    });
    expect(solverSet.get('solver-delivery').keyId).toBe(solverStore.key('solver-delivery').keyId);
    expect(solverSet.get('solver-settlement').keyId).toBe(solverStore.key('solver-settlement').keyId);

    const requesterSet = await openRoleIdentitySet({
      agent: AGENT,
      requiredRoles: ['requester-submission', 'requester-discovery'],
      storePath: requesterStore.storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now: () => NOW,
    });
    expect(requesterSet.get('requester-submission').keyId)
      .toBe(requesterStore.key('requester-submission').keyId);

    const admissionSet = await openRoleIdentitySet({
      agent: ADMISSION_AGENT,
      requiredRoles: ['admission'],
      storePath: admissionStore.storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now: () => NOW,
    });
    expect(admissionSet.get('admission').keyId).toBe(admissionStore.key('admission').keyId);

    // The verdict/deliveries dual-scope role also opens (evaluator custody).
    const evaluatorStore = await mintIdentityStore({
      storePath: join(root, 'evaluator.enc.json'),
      password: PASSWORD,
      roles: ['evaluator-verdict', 'evaluator-settlement', 'evaluator-discovery'],
    });
    const authored2 = await authorNativeTrustCatalog({
      path: join(root, 'trust-eval.json'),
      roleKeys: evaluatorStore.keys.map((key) => ({ key, agent: AGENT })),
      ceremonyAccount: CEREMONY_ACCOUNT,
    });
    const trust2 = await openNativeTrustCatalog({
      path: authored2.path,
      expectedPolicyGenesisDigest: authored2.policyGenesisDigest,
      anchorClient: authored2.mockAnchorClient!,
      now: NOW,
    });
    const evaluatorSet = await openRoleIdentitySet({
      agent: AGENT,
      requiredRoles: ['evaluator-verdict', 'evaluator-settlement', 'evaluator-discovery'],
      storePath: evaluatorStore.storePath,
      password: PASSWORD,
      bindingResolver: trust2.bindingResolver,
      verifyRoleBinding: trust2.verifyRoleBinding,
      now: () => NOW,
    });
    expect(evaluatorSet.get('evaluator-verdict').keyId)
      .toBe(evaluatorStore.key('evaluator-verdict').keyId);
  });

  it('builds a two-operator setup whose shared catalog resolves BOTH operators\' role keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-fleet-two-op-'));
    const setup = await buildTwoOperatorNativeSetup({
      rootDir: root,
      password: PASSWORD,
      rpcUrl: 'http://127.0.0.1:0',
      ipfsApiUrl: 'http://127.0.0.1:0',
      ceremonyAccount: CEREMONY_ACCOUNT,
      // no submitAnchor -> mock anchor path
      aPublicBaseUrl: 'http://127.0.0.1:0/a',
      bPublicBaseUrl: 'http://127.0.0.1:0/b',
      aSafeAddress: `0x${'11'.repeat(20)}`,
    });

    // Distinct, honestly-separate operators.
    expect(setup.operatorA.agentIri).not.toBe(setup.operatorB.agentIri);
    expect(setup.operatorA.solverStore.storePath).not.toBe(setup.operatorB.solverStore.storePath);
    // A carries requester write authority (admission custody); B does not.
    expect(setup.operatorA.config.admissionAgent).toBeDefined();
    expect(setup.operatorB.config.admissionAgent).toBeUndefined();
    // A's posting entry points at a status:'launched' record.
    const launchedBytes = setup.operatorA.launched!.record;
    expect(LaunchedSolverNetRecordSchema.parse(launchedBytes).status).toBe('launched');
    expect(setup.operatorA.config.posting).toHaveLength(1);

    // The shared catalog opens and resolves role keys for BOTH agents (mock anchor).
    const trust = await openNativeTrustCatalog({
      path: setup.trustRootsPath,
      expectedPolicyGenesisDigest: setup.trustPolicyGenesisDigest,
      anchorClient: setup.mockAnchorClientTrust!.mockAnchorClient!,
      now: NOW,
    });
    const aSolver = await openRoleIdentitySet({
      agent: setup.operatorA.agentIri,
      requiredRoles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
      storePath: setup.operatorA.solverStore.storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now: () => NOW,
    });
    expect(aSolver.get('solver-delivery').keyId)
      .toBe(setup.operatorA.solverStore.key('solver-delivery').keyId);
    const bSolver = await openRoleIdentitySet({
      agent: setup.operatorB.agentIri,
      requiredRoles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
      storePath: setup.operatorB.solverStore.storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now: () => NOW,
    });
    expect(bSolver.get('solver-delivery').keyId)
      .toBe(setup.operatorB.solverStore.key('solver-delivery').keyId);
  });
});
