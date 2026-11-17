/**
 * `jinn ceremony rotate` (#5236): retires a role family's keys and binds new ones, for an operator
 * `init` provisioned. As in the other ceremony tests only the chain-touching deps are injected;
 * custody, ceremonies, bindings, revocations and the catalog are the real
 * `@jinn-network/trust-authoring` code. The agent EOA is a real viem account, because a revocation
 * carries its EIP-191 signature and authoring refuses one that does not recover to it. What rotate
 * writes is then opened by the production catalog opener and role identities.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRoleSigners, revocationAnchorDigest } from '@jinn-network/trust-authoring';
import { didPkh, validateKeyBinding } from '@jinn-network/trust-core';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import {
  ceremonyAnchorDigest,
  createCeremonyCommand,
  type CeremonyCommandDeps,
} from '../../src/cli/commands/ceremony.js';
import type { CommandContext } from '../../src/cli/command.js';
import { openNativeTrustCatalog } from '../../src/daemon/native-trust-catalog.js';
import { openRoleIdentitySet, type NativeRoleIdentityRole } from '../../src/daemon/role-identities.js';

const SAFE = '0x8464135c8F25Da09e49BC8782676a84730C318bC' as const;
const PASSWORD = 'ceremony-rotate-test-password';
const SOLVER_ROLES: readonly NativeRoleIdentityRole[] = ['solver-delivery', 'solver-settlement', 'solver-discovery'];
const agentAccount = privateKeyToAccount(`0x${'61'.repeat(32)}`);
const strangerAccount = privateKeyToAccount(`0x${'62'.repeat(32)}`);

interface Submitted {
  readonly digest: `sha256:${string}`;
  readonly anchorTime: string;
  readonly transactionHash: `0x${string}`;
}

function harness(options: { readonly failRevocationFinality?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ceremony-rotate-'));
  const dir = join(home, '.jinn-operator');
  mkdirSync(dir, { recursive: true });
  const calls: string[] = [];
  const submitted: Submitted[] = [];
  let account = agentAccount;
  let finalityWaits = 0;
  const deps: CeremonyCommandDeps = {
    async readChainCustody() {
      calls.push('readChainCustody');
      return { serviceIndex: 72, agentEoa: account.address, safeAddress: SAFE };
    },
    async verifySafeOwnership() { return true; },
    async openAnchorSession() {
      calls.push('openAnchorSession');
      const signer = account;
      return {
        async signMessage(input) { return signer.signMessage({ message: { raw: input.message.raw } }); },
        async submit(digest) {
          calls.push(`submit:${digest}`);
          // Each anchor mines ten minutes after the last, from a fixed genesis block time.
          const seconds = 1_786_000_000 + submitted.length * 600;
          const anchor = {
            digest,
            anchorTime: new Date(seconds * 1_000).toISOString(),
            transactionHash: `0x${seconds.toString(16).padStart(64, '0')}` as `0x${string}`,
          };
          submitted.push(anchor);
          return {
            profile: 'https://spec.jinn.network/trust/anchor-locators/base-sepolia-calldata-v1',
            chainId: 84532,
            transactionHash: anchor.transactionHash,
            contractAddress: signer.address,
            inputByteOffset: 0,
            anchorTime: anchor.anchorTime,
          };
        },
        async waitForFinalized(input) {
          finalityWaits += 1;
          calls.push('waitForFinalized');
          // The third wait: genesis, then the rebind, then the revocation.
          if (options.failRevocationFinality === true && finalityWaits === 3) {
            throw new Error('killed during the revocation finality wait');
          }
          return {
            digest: input.digest,
            anchorTime: input.locator.anchorTime,
            chainId: 84532,
            transactionHash: input.locator.transactionHash,
            blockHash: `0x${'ef'.repeat(32)}`,
            blockNumber: 1n,
            finalized: true,
          };
        },
      };
    },
  };
  return {
    home,
    dir,
    configPath: join(dir, 'config.json'),
    catalogPath: join(dir, 'trust.json'),
    authorityStore: join(home, '.jinn-ceremony', 'authority.enc.json'),
    deps,
    calls,
    submitted,
    useAccount(next: typeof agentAccount) { account = next; },
  };
}

type Harness = ReturnType<typeof harness>;

async function run(h: Harness, argv: string[]): Promise<Record<string, unknown>> {
  const writes: string[] = [];
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: false,
    writer: { write: (text: string) => { writes.push(text); return true; } },
    exit: () => undefined,
    env: { HOME: h.home, JINN_PASSWORD: PASSWORD } as NodeJS.ProcessEnv,
  };
  await createCeremonyCommand(h.deps).run(ctx);
  const envelopes = writes.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  return envelopes[envelopes.length - 1]!;
}

async function provisioned(options: { readonly failRevocationFinality?: boolean } = {}): Promise<Harness> {
  const h = harness(options);
  const init = await run(h, [
    'init', '--dir', h.dir, '--role-sets', 'requester,admission,solver', '--authority-store', h.authorityStore, '--execute',
  ]);
  expect(init.kind).toBe('ceremony_init_complete');
  return h;
}

function config(h: Harness): {
  agentIri: string;
  admissionAgent: string;
  identityStores: Record<string, string>;
  trustPolicyGenesisDigest: `sha256:${string}`;
} {
  return JSON.parse(readFileSync(h.configPath, 'utf-8'));
}

function catalogBindings(h: Harness) {
  const file = JSON.parse(readFileSync(h.catalogPath, 'utf-8')) as { bindings: { digest: string; envelope: string }[] };
  return file.bindings.map(({ digest, envelope }) => ({
    digest,
    binding: validateKeyBinding(new Uint8Array(Buffer.from(envelope, 'base64'))).value!,
  }));
}

async function openCatalog(h: Harness, now: string) {
  return openNativeTrustCatalog({
    path: h.catalogPath,
    expectedPolicyGenesisDigest: config(h).trustPolicyGenesisDigest,
    anchorClient: {
      async lookupFinalizedAnchor({ digest }) {
        const found = h.submitted.find((anchor) => anchor.digest === digest);
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
    },
    settlementOwnershipClient: {
      async isOwner(safe, owner) {
        return safe.toLowerCase() === SAFE.toLowerCase() && owner.toLowerCase() === agentAccount.address.toLowerCase();
      },
    },
    now: new Date(now),
  });
}

describe('ceremony rotate', () => {
  it('plans without side effects: the retiring keys, the new stores, and the revocation anchor', async () => {
    const h = await provisioned();
    const before = readFileSync(h.catalogPath);
    const submissions = h.submitted.length;

    const plan = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver']);

    expect(plan.kind).toBe('ceremony_rotate_plan');
    expect(plan.sideEffects).toBe(false);
    const retiring = plan.retiring as { role: string; bindingDigests: `sha256:${string}`[] }[];
    expect(retiring.map(({ role }) => role)).toEqual(SOLVER_ROLES);
    expect(plan.revocationAnchorDigest).toBe(revocationAnchorDigest({
      targets: retiring.flatMap(({ bindingDigests }) => bindingDigests),
      revokedBy: didPkh(84532, agentAccount.address),
    }));
    const newStore = (plan.newStores as Record<string, string>).solver!;
    expect(newStore).not.toBe(config(h).identityStores.solver);
    expect(existsSync(newStore)).toBe(false);
    expect(h.submitted.length).toBe(submissions);
    expect(readFileSync(h.catalogPath)).toEqual(before);
  });

  it('rebinds, then revokes, then repoints the config: the new store boots and the retired one is refused', async () => {
    const h = await provisioned();
    const retiredStore = config(h).identityStores.solver!;
    const before = catalogBindings(h);

    const result = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);

    expect(result.kind).toBe('ceremony_rotate_complete');
    expect(result.restartRequired).toBe(true);
    const retired = result.retired as { bindingDigests: `sha256:${string}`[] }[];
    const bound = result.bindings as { role: string; keyId: string }[];
    // Two fresh anchors after the genesis one, in order: the rebind over the replacement keys, then
    // the revocation of the retiring bindings by the agent EOA.
    const [, rebind, revocation] = h.submitted;
    const { agentIri, admissionAgent } = config(h);
    expect(rebind!.digest).toBe(ceremonyAnchorDigest({
      agentIri,
      admissionAgent,
      safeAddress: SAFE,
      keys: bound.map(({ role, keyId }) => ({ role, keyId })),
    }));
    expect(revocation!.digest).toBe(revocationAnchorDigest({
      targets: retired.flatMap(({ bindingDigests }) => bindingDigests),
      revokedBy: didPkh(84532, agentAccount.address),
    }));
    expect(h.submitted).toHaveLength(3);

    const newStore = config(h).identityStores.solver!;
    expect(newStore).not.toBe(retiredStore);
    expect(catalogBindings(h)).toHaveLength(before.length + SOLVER_ROLES.length);

    const trust = await openCatalog(h, revocation!.anchorTime);
    const openAt = (storePath: string, at: string) => openRoleIdentitySet({
      agent: agentIri,
      requiredRoles: SOLVER_ROLES,
      storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      revocationAuthority: trust,
      verifyRoleBinding: trust.verifyRoleBinding,
      now: () => new Date(at),
    });
    await expect(openAt(retiredStore, revocation!.anchorTime)).rejects.toThrow(/binding is revoked at boot/u);
    const rotated = await openAt(newStore, revocation!.anchorTime);
    for (const role of SOLVER_ROLES) {
      await expect(rotated.resolveEffective(role, revocation!.anchorTime)).resolves.toMatchObject({ ok: true });
    }
  });

  it('rotates the admission family, whose Agent holds no other binding, because the rebind comes first', async () => {
    const h = await provisioned();
    const { admissionAgent } = config(h);
    const retired = catalogBindings(h).find(({ binding }) => binding.agent === admissionAgent)!;

    const result = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'admission', '--execute']);

    expect(result.kind).toBe('ceremony_rotate_complete');
    const [successor] = result.bindings as { keyId: string }[];
    const revokedAt = h.submitted[2]!.anchorTime;
    const trust = await openCatalog(h, revokedAt);
    const family = 'https://spec.jinn.network/trust-scopes/admission-receipts/v1';
    await expect(trust.verifyRoleBinding({
      role: 'admission', key: retired.binding.key.didKey, agent: admissionAgent, family, atTime: revokedAt,
    })).rejects.toThrow(/revoked/u);
    await expect(trust.verifyRoleBinding({
      role: 'admission', key: successor!.keyId, agent: admissionAgent, family, atTime: revokedAt,
    })).resolves.toMatchObject({ bindingDigest: expect.stringMatching(/^sha256:/u) });
  });

  it('refuses before any anchor when the agent EOA did not vouch for the retiring bindings', async () => {
    const h = await provisioned();
    const submissions = h.submitted.length;
    const sessions = h.calls.filter((call) => call === 'openAnchorSession').length;
    const before = readFileSync(h.catalogPath);
    h.useAccount(strangerAccount);

    const refusal = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);

    expect(refusal.code).toBe('invalid_invocation');
    expect(String(refusal.message)).toContain('cannot revoke the retiring bindings');
    expect(h.submitted.length).toBe(submissions);
    expect(h.calls.filter((call) => call === 'openAnchorSession')).toHaveLength(sessions);
    expect(readFileSync(h.catalogPath)).toEqual(before);
  });

  it('refuses a family the operator never provisioned', async () => {
    const h = await provisioned();
    const refusal = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'evaluator']);
    expect(refusal.code).toBe('invalid_invocation');
    expect(String(refusal.message)).toContain('no identityStores.evaluator');
  });

  it('resumes an interrupted rotation onto the same new store, without a second rebind', async () => {
    const h = await provisioned({ failRevocationFinality: true });
    await expect(run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']))
      .rejects.toThrow(/killed during the revocation finality wait/u);
    const receipt = JSON.parse(readFileSync(join(h.dir, 'ceremony', 'rotation.json'), 'utf-8')) as {
      stores: Record<string, string>;
    };
    const afterRebind = catalogBindings(h).length;

    const result = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);

    expect(result.kind).toBe('ceremony_rotate_complete');
    expect(result.resumed).toBe(true);
    expect(result.rebindAnchor).toBeNull();
    expect(config(h).identityStores.solver).toBe(receipt.stores.solver);
    expect(catalogBindings(h)).toHaveLength(afterRebind);
    // genesis, the rebind, the interrupted revocation, and the revocation that landed.
    expect(h.submitted).toHaveLength(4);
  });

  it('refuses to retire keys the catalog never bound', async () => {
    const h = await provisioned();
    const stray = join(h.dir, 'identity', 'stray.enc.json');
    writeFileSync(h.configPath, JSON.stringify({ ...config(h), identityStores: { ...config(h).identityStores, solver: stray } }));
    await openRoleSigners({ storePath: stray, password: PASSWORD, ownedRoles: SOLVER_ROLES, create: true });

    const refusal = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver']);
    expect(refusal.code).toBe('invalid_invocation');
    expect(String(refusal.message)).toContain('there is nothing to rotate');
  });
});
