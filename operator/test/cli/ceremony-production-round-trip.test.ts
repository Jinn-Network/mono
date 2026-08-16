/**
 * `jinn ceremony init` + `jinn ceremony join`, opened by the PRODUCTION verifiers, for TWO operators
 * with distinct EOAs and distinct Safes.
 *
 * This is the only test that proves the exact geometry of the live two-operator run
 * (spec/2026-08-07-native-identity-ceremony.md §4.4). Everything trust-bearing here is the shipped
 * code: `openNativeTrustCatalog` and `RoleIdentitySet.open` are the daemon's own boot path, the
 * ceremony signatures are real EIP-191 signatures from local viem accounts, and the artifacts under
 * test are whatever the CLI actually wrote to disk. Only chain READS are stood in for — the
 * finalized-anchor lookup and `Safe.isOwner` — because those are chain state, not trust rungs.
 *
 * It is deliberately distinct from `test/daemon/trust-authoring-round-trip.test.ts`, which exercises
 * the same openers one layer down and (issue #2509) shares one EOA and one Safe across its two
 * operators. A shared-custody rig cannot see the failure this one is built to catch: a CLI that
 * bound operator B's keys to operator A's settlement authority would pass there and lose funds here.
 */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { createCeremonyCommand, type CeremonyCommandDeps } from '../../src/cli/commands/ceremony.js';
import type { CommandContext } from '../../src/cli/command.js';
import {
  openNativeTrustCatalog,
  type NativeFinalizedAnchorReadClient,
  type NativeSettlementOwnershipReadClient,
} from '../../src/daemon/native-trust-catalog.js';
import { RoleIdentitySet, type NativeRoleIdentityRole } from '../../src/daemon/role-identities.js';

const PASSWORD = 'ceremony-two-operator-round-trip';

/** Distinct EOAs. Operator B's ceremony must never be signable by operator A's key, or vice versa. */
const ACCOUNT_A = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const ACCOUNT_B = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
/** Distinct Safes — the §2.3b third ceremony resource, and the thing settlement actually pays out of. */
const SAFE_A = '0x8464135c8F25Da09e49BC8782676a84730C318bC' as const;
const SAFE_B = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;

const ANCHOR_TIME_A = '2026-08-07T12:00:00.000Z';
const ANCHOR_TIME_B = '2026-08-07T12:30:00.000Z';

interface Operator {
  readonly dir: string;
  readonly account: typeof ACCOUNT_A;
  readonly safe: `0x${string}`;
  readonly anchorTime: string;
  readonly serviceIndex: number;
}

function captureIo() {
  const writes: string[] = [];
  const exits: number[] = [];
  return {
    writer: { write: (text: string) => { writes.push(text); return true; } },
    exit: (code: number) => { exits.push(code); },
    writes,
    exits,
  };
}

function lastEnvelope(writes: string[]): Record<string, unknown> {
  const all = writes.flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
  return all[all.length - 1]!;
}

/**
 * One dep set serving BOTH operators, dispatching on `--dir`. That is the shape of the live run
 * (two homes, one machine, one binary) and it is what makes an accidental cross-wiring — operator B
 * signing with A's EOA, or declaring A's Safe — a thing this rig can actually express and then fail.
 */
function twoOperatorDeps(operators: readonly Operator[]): {
  readonly deps: CeremonyCommandDeps;
  readonly submitted: { digest: string; transactionHash: `0x${string}`; anchorTime: string }[];
} {
  const submitted: { digest: string; transactionHash: `0x${string}`; anchorTime: string }[] = [];
  const forDir = (dir: string): Operator => {
    const found = operators.find((operator) => operator.dir === dir);
    if (found === undefined) throw new Error(`no operator configured for ${dir}`);
    return found;
  };
  return {
    submitted,
    deps: {
      async readChainCustody({ dir }) {
        const operator = forDir(dir);
        return {
          serviceIndex: operator.serviceIndex,
          agentEoa: operator.account.address,
          safeAddress: operator.safe,
        };
      },
      /** The CLI preflight, answered by the same per-operator geometry the opener later re-reads. */
      async verifySafeOwnership({ safeAddress, agentEoa }) {
        return operators.some((operator) => operator.safe.toLowerCase() === safeAddress.toLowerCase()
          && operator.account.address.toLowerCase() === agentEoa.toLowerCase());
      },
      async openAnchorSession({ dir }) {
        const operator = forDir(dir);
        return {
          // A REAL EIP-191 signature by THIS operator's EOA. The whole settlement chain hangs off
          // `recoverEip191Address` agreeing with the ceremony's declared address.
          signMessage: (input) => operator.account.signMessage(input),
          async submit(digest) {
            const transactionHash = `0x${Buffer.from(digest.slice('sha256:'.length), 'hex')
              .subarray(0, 32).toString('hex')}` as `0x${string}`;
            submitted.push({ digest, transactionHash, anchorTime: operator.anchorTime });
            return {
              profile: 'https://spec.jinn.network/trust/anchor-locators/base-sepolia-calldata-v1',
              chainId: 84532,
              transactionHash,
              contractAddress: operator.account.address,
              inputByteOffset: 0,
              anchorTime: operator.anchorTime,
            };
          },
          async waitForFinalized(input) {
            return {
              digest: input.digest,
              anchorTime: operator.anchorTime,
              chainId: 84532,
              transactionHash: input.locator.transactionHash,
              blockHash: `0x${'ef'.repeat(32)}`,
              blockNumber: 1n,
              finalized: true,
            };
          },
        };
      },
    },
  };
}

/** Stand-in #1: the finalized-anchor read. Every anchor the CLI actually submitted reads back final. */
function anchorClientFor(
  submitted: readonly { digest: string; transactionHash: `0x${string}`; anchorTime: string }[],
): NativeFinalizedAnchorReadClient {
  return {
    async lookupFinalizedAnchor({ digest }) {
      const found = submitted.find((entry) => entry.digest === digest);
      if (found === undefined) return null;
      return {
        digest,
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

/** Stand-in #2: §2.3c step 5. Each Safe owns exactly its own operator's EOA — nobody else's. */
function ownershipFor(
  entries: readonly { readonly safe: `0x${string}`; readonly owners: readonly `0x${string}`[] }[],
): NativeSettlementOwnershipReadClient {
  return {
    async isOwner(safe, candidate) {
      const found = entries.find((entry) => entry.safe.toLowerCase() === safe.toLowerCase());
      return found !== undefined
        && found.owners.some((owner) => owner.toLowerCase() === candidate.toLowerCase());
    },
  };
}

function run(input: { readonly argv: string[]; readonly home: string; readonly deps: CeremonyCommandDeps }) {
  const io = captureIo();
  const ctx: CommandContext = {
    argv: input.argv,
    stdoutIsTty: false,
    writer: io.writer,
    exit: io.exit,
    env: { HOME: input.home, JINN_PASSWORD: PASSWORD } as NodeJS.ProcessEnv,
  };
  return { io, promise: createCeremonyCommand(input.deps).run(ctx) };
}

interface RoundTrip {
  readonly home: string;
  readonly a: Operator;
  readonly b: Operator;
  readonly catalogPath: string;
  readonly genesis: `sha256:${string}`;
  readonly agentA: string;
  readonly admissionAgentA: string;
  readonly agentB: string;
  readonly anchorClient: NativeFinalizedAnchorReadClient;
  readonly newestPolicyVersion: number;
}

/** `init` for operator A, then `join` for operator B — the exact two commands of the live run. */
async function twoOperatorCeremony(): Promise<RoundTrip> {
  const home = mkdtempSync(join(tmpdir(), 'ceremony-round-trip-'));
  const a: Operator = {
    dir: join(home, '.jinn-client'),
    account: ACCOUNT_A,
    safe: SAFE_A,
    anchorTime: ANCHOR_TIME_A,
    serviceIndex: 72,
  };
  const b: Operator = {
    dir: join(home, '.jinn-client-op-b'),
    account: ACCOUNT_B,
    safe: SAFE_B,
    anchorTime: ANCHOR_TIME_B,
    serviceIndex: 75,
  };
  mkdirSync(a.dir, { recursive: true });
  mkdirSync(b.dir, { recursive: true });
  const authorityStore = join(home, '.jinn-ceremony', 'authority.enc.json');
  const catalogPath = join(a.dir, 'trust.json');
  const { deps, submitted } = twoOperatorDeps([a, b]);

  const init = run({
    home,
    deps,
    argv: [
      'init', '--dir', a.dir,
      '--role-sets', 'requester,admission,solver,evaluator',
      '--authority-store', authorityStore, '--execute',
    ],
  });
  await init.promise;
  const initResult = lastEnvelope(init.io.writes);
  expect(initResult.kind).toBe('ceremony_init_complete');

  const join_ = run({
    home,
    deps,
    argv: [
      'join', '--dir', b.dir,
      '--role-sets', 'requester,solver,evaluator',
      '--catalog', catalogPath,
      '--genesis', String(initResult.policyGenesisDigest),
      '--authority-store', authorityStore, '--execute',
    ],
  });
  await join_.promise;
  const joinResult = lastEnvelope(join_.io.writes);
  expect(joinResult.kind).toBe('ceremony_join_complete');

  return {
    home,
    a,
    b,
    catalogPath,
    genesis: String(initResult.policyGenesisDigest) as `sha256:${string}`,
    agentA: String(initResult.agentIri),
    admissionAgentA: String(initResult.admissionAgent),
    agentB: String(joinResult.agentIri),
    anchorClient: anchorClientFor(submitted),
    newestPolicyVersion: Number(joinResult.newestPolicyVersion),
  };
}

/** Both Safes present, each owning only its own operator's EOA — the live run's true geometry. */
function honestOwnership(trip: RoundTrip): NativeSettlementOwnershipReadClient {
  return ownershipFor([
    { safe: trip.a.safe, owners: [trip.a.account.address] },
    { safe: trip.b.safe, owners: [trip.b.account.address] },
  ]);
}

function openCatalog(trip: RoundTrip, ownership: NativeSettlementOwnershipReadClient) {
  return openNativeTrustCatalog({
    path: trip.catalogPath,
    expectedPolicyGenesisDigest: trip.genesis,
    anchorClient: trip.anchorClient,
    settlementOwnershipClient: ownership,
    now: new Date(ANCHOR_TIME_B),
  });
}

const FAMILIES: Readonly<Record<string, readonly NativeRoleIdentityRole[]>> = {
  requester: ['requester-submission', 'requester-discovery'],
  admission: ['admission'],
  solver: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
  evaluator: ['evaluator-verdict', 'evaluator-settlement', 'evaluator-discovery'],
};

describe('jinn ceremony → production verifiers, two operators, distinct EOAs and Safes', () => {
  it('opens every role family of BOTH operators with the shipped RoleIdentitySet', async () => {
    const trip = await twoOperatorCeremony();
    const trust = await openCatalog(trip, honestOwnership(trip));
    expect(trust.conflicts).toEqual([]);
    expect(trust.newestPolicyVersion).toBe(2);

    const now = () => new Date(ANCHOR_TIME_B);
    const open = (dir: string, agent: string, family: keyof typeof FAMILIES) => RoleIdentitySet.open({
      agent,
      requiredRoles: FAMILIES[family]!,
      storePath: join(dir, 'identity', `${family}.enc.json`),
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now,
    });

    const aRequester = await open(trip.a.dir, trip.agentA, 'requester');
    const aAdmission = await open(trip.a.dir, trip.admissionAgentA, 'admission');
    const aSolver = await open(trip.a.dir, trip.agentA, 'solver');
    const aEvaluator = await open(trip.a.dir, trip.agentA, 'evaluator');
    const bRequester = await open(trip.b.dir, trip.agentB, 'requester');
    const bSolver = await open(trip.b.dir, trip.agentB, 'solver');
    const bEvaluator = await open(trip.b.dir, trip.agentB, 'evaluator');

    for (const [set, family] of [
      [aRequester, 'requester'], [aAdmission, 'admission'], [aSolver, 'solver'], [aEvaluator, 'evaluator'],
      [bRequester, 'requester'], [bSolver, 'solver'], [bEvaluator, 'evaluator'],
    ] as const) {
      for (const role of FAMILIES[family]!) expect(set.get(role).keyId).toMatch(/^did:key:z/u);
    }

    // No key is shared between the two operators, or between A's own identity and its admission
    // authority. Distinct custody is the premise the whole settlement chain rests on.
    const keyIds = [
      ...FAMILIES.solver!.map((role) => aSolver.get(role).keyId),
      ...FAMILIES.solver!.map((role) => bSolver.get(role).keyId),
      aAdmission.get('admission').keyId,
      aRequester.get('requester-submission').keyId,
      bRequester.get('requester-submission').keyId,
    ];
    expect(new Set(keyIds).size).toBe(keyIds.length);
    expect(trip.agentA).not.toBe(trip.agentB);
    expect(trip.admissionAgentA).not.toBe(trip.agentA);
    expect(trip.a.account.address).not.toBe(trip.b.account.address);
    expect(trip.a.safe).not.toBe(trip.b.safe);
  });

  it('keeps the genesis digest stable across the join, in the catalog and in both configs', async () => {
    const trip = await twoOperatorCeremony();
    const catalog = JSON.parse(readFileSync(trip.catalogPath, 'utf-8')) as { policyGenesisDigest: string };
    const configA = JSON.parse(readFileSync(join(trip.a.dir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    const configB = JSON.parse(readFileSync(join(trip.b.dir, 'config.json'), 'utf-8')) as Record<string, unknown>;

    expect(catalog.policyGenesisDigest).toBe(trip.genesis);
    expect(configA.trustPolicyGenesisDigest).toBe(trip.genesis);
    expect(configB.trustPolicyGenesisDigest).toBe(trip.genesis);
    // A's config is what pins the deployment authority; B joining must not have moved it, or every
    // existing operator's daemon would refuse the catalog at its next boot.
    expect(configA.agentIri).toBe(trip.agentA);
    expect(configB.agentIri).toBe(trip.agentB);
    // B provisioned no admission family, so it claims no admission authority.
    expect(configB.admissionAgent).toBeUndefined();
    expect(configA.admissionAgent).toBe(trip.admissionAgentA);
  });

  it('carries the complete purpose set for both operators', async () => {
    const trip = await twoOperatorCeremony();
    const trust = await openCatalog(trip, honestOwnership(trip));

    // `policy` throws on an absent purpose, so reaching the assertion is itself the coverage check.
    expect(trust.policy('evaluator-eligibility').accepted).toEqual(
      expect.arrayContaining([trip.agentA, trip.agentB]),
    );
    expect(trust.policy('admission-agent').accepted).toContain(trip.admissionAgentA);
    expect(trust.policy('native:admission').accepted).toContain(trip.admissionAgentA);
    // Admission is A's separate signing authority, never the operator IRI it admits for.
    expect(trust.policy('admission-agent').accepted).not.toContain(trip.agentA);
    for (const purpose of ['native:solver-settlement', 'native:requester-submission', 'native:evaluator-verdict']) {
      expect(trust.policy(purpose).accepted).toEqual(expect.arrayContaining([trip.agentA, trip.agentB]));
    }
  });

  /** §2.3b: each operator's settlement ceremonies name ITS OWN Safe as the third resource. */
  it('binds each operator\'s settlement roles to its own Safe', async () => {
    const trip = await twoOperatorCeremony();
    const trust = await openCatalog(trip, honestOwnership(trip));
    const now = () => new Date(ANCHOR_TIME_B);
    const settlementKey = async (dir: string, agent: string, family: 'solver' | 'evaluator') => {
      const set = await RoleIdentitySet.open({
        agent,
        requiredRoles: FAMILIES[family]!,
        storePath: join(dir, 'identity', `${family}.enc.json`),
        password: PASSWORD,
        bindingResolver: trust.bindingResolver,
        verifyRoleBinding: trust.verifyRoleBinding,
        now,
      });
      return set.get(family === 'solver' ? 'solver-settlement' : 'evaluator-settlement').keyId;
    };

    for (const [dir, agent, safe] of [
      [trip.a.dir, trip.agentA, trip.a.safe],
      [trip.b.dir, trip.agentB, trip.b.safe],
    ] as const) {
      for (const family of ['solver', 'evaluator'] as const) {
        const key = await settlementKey(dir, agent, family);
        await expect(trust.verifyOnchainAuthority({
          key,
          agent,
          address: safe,
          atTime: ANCHOR_TIME_B,
          purpose: family === 'solver' ? 'native:solver-settlement' : 'native:evaluator-settlement',
        })).resolves.toMatchObject({ bindingDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) });
      }
    }
  });

  /**
   * The cross-operator refusal — the failure a shared-EOA/shared-Safe rig cannot see (#2509).
   *
   * Operator A's Safe must not accept operator B's key, and the refusal must land at the DECLARED
   * RESOURCE: B's ceremony names B's Safe inside the EIP-191-signed bytes, so it cannot be
   * re-pointed at A's Safe after the fact.
   */
  it('refuses operator A\'s Safe for operator B\'s settlement key, and vice versa', async () => {
    const trip = await twoOperatorCeremony();
    const trust = await openCatalog(trip, honestOwnership(trip));
    const now = () => new Date(ANCHOR_TIME_B);
    const solverKey = async (dir: string, agent: string) => (await RoleIdentitySet.open({
      agent,
      requiredRoles: FAMILIES.solver!,
      storePath: join(dir, 'identity', 'solver.enc.json'),
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now,
    })).get('solver-settlement').keyId;

    const keyA = await solverKey(trip.a.dir, trip.agentA);
    const keyB = await solverKey(trip.b.dir, trip.agentB);

    await expect(trust.verifyOnchainAuthority({
      key: keyB, agent: trip.agentB, address: trip.a.safe,
      atTime: ANCHOR_TIME_B, purpose: 'native:solver-settlement',
    })).rejects.toThrow(/declares settlement resource/u);
    await expect(trust.verifyOnchainAuthority({
      key: keyA, agent: trip.agentA, address: trip.b.safe,
      atTime: ANCHOR_TIME_B, purpose: 'native:solver-settlement',
    })).rejects.toThrow(/declares settlement resource/u);

    // And the underlying chain fact the refusal protects: A's Safe does not own B's signer.
    const ownership = honestOwnership(trip);
    expect(await ownership.isOwner(trip.a.safe, trip.b.account.address)).toBe(false);
    expect(await ownership.isOwner(trip.b.safe, trip.a.account.address)).toBe(false);
    expect(await ownership.isOwner(trip.a.safe, trip.a.account.address)).toBe(true);
  });

  /**
   * The §2.3c step-5 rung is live and PER-OPERATOR: when A's Safe stops owning A's EOA — a key
   * rotation on the Safe, which is a real operational event — A's settlement authority refuses
   * while B's, untouched, still verifies.
   */
  it('refuses a settlement authority whose own Safe no longer owns its ceremony signer', async () => {
    const trip = await twoOperatorCeremony();
    const rotated = ownershipFor([
      // A's Safe now lists B's EOA instead of A's — the misconfiguration the rung exists to catch.
      { safe: trip.a.safe, owners: [trip.b.account.address] },
      { safe: trip.b.safe, owners: [trip.b.account.address] },
    ]);
    const trust = await openCatalog(trip, rotated);
    const now = () => new Date(ANCHOR_TIME_B);
    const solverKey = async (dir: string, agent: string) => (await RoleIdentitySet.open({
      agent,
      requiredRoles: FAMILIES.solver!,
      storePath: join(dir, 'identity', 'solver.enc.json'),
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now,
    })).get('solver-settlement').keyId;

    await expect(trust.verifyOnchainAuthority({
      key: await solverKey(trip.a.dir, trip.agentA), agent: trip.agentA, address: trip.a.safe,
      atTime: ANCHOR_TIME_B, purpose: 'native:solver-settlement',
    })).rejects.toThrow(/does not own ceremony signer/u);

    await expect(trust.verifyOnchainAuthority({
      key: await solverKey(trip.b.dir, trip.agentB), agent: trip.agentB, address: trip.b.safe,
      atTime: ANCHOR_TIME_B, purpose: 'native:solver-settlement',
    })).resolves.toBeDefined();
  });
});
