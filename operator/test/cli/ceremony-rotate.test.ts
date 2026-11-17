/**
 * `jinn ceremony rotate` (#5236): retires a role family's keys and binds new ones, for an operator
 * `init` provisioned. As in the other ceremony tests only the chain-touching deps are injected;
 * custody, ceremonies, bindings, revocations and the catalog are the real
 * `@jinn-network/trust-authoring` code. The agent EOA is a real viem account, because a revocation
 * carries its EIP-191 signature and authoring refuses one that does not recover to it. What rotate
 * writes is then opened by the production catalog opener and role identities.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRoleSigners, revocationAnchorDigest } from '@jinn-network/trust-authoring';
import { didPkh, validateKeyBinding } from '@jinn-network/trust-core';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ceremonyAnchorDigest,
  createCeremonyCommand,
  type CeremonyCommandDeps,
} from '../../src/cli/commands/ceremony.js';
import type { CommandContext } from '../../src/cli/command.js';
import { orderedRolesForSet } from '../../src/cli/commands/native-requester.js';
import { openNativeTrustCatalog } from '../../src/daemon/native-trust-catalog.js';
import { openRoleIdentitySet, type NativeRoleIdentityRole } from '../../src/daemon/role-identities.js';

/**
 * A full disk, armed for one write: the next write into a file whose path starts with `path` lands
 * half its bytes and then fails with ENOSPC, as a write that runs out of space does. A write through
 * a descriptor is matched by the path it was opened at. Every other write passes through.
 */
const diskFull = vi.hoisted(() => ({ path: undefined as string | undefined, fired: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const opened = new Map<number, string>();
  const openSync: typeof actual.openSync = (path, ...rest) => {
    const fd = actual.openSync(path, ...rest);
    opened.set(fd, String(path));
    return fd;
  };
  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    const path = typeof file === 'number' ? opened.get(file) : String(file);
    if (diskFull.path !== undefined && path?.startsWith(diskFull.path) === true) {
      diskFull.path = undefined;
      diskFull.fired = true;
      const bytes = typeof data === 'string'
        ? Buffer.from(data)
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      actual.writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 2)), options);
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    }
    actual.writeFileSync(file, data, options);
  };
  return { ...actual, openSync, writeFileSync, default: { ...actual, openSync, writeFileSync } };
});

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

interface HarnessOptions {
  /** Throw from the finality wait of this act, once: the run is killed while waiting. */
  readonly interruptWait?: 'rebind' | 'revocation';
}

function harness(options: HarnessOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ceremony-rotate-'));
  const dir = join(home, '.jinn-operator');
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'config.json');
  const calls: string[] = [];
  const submitted: Submitted[] = [];
  /** `identityStores` as the config named it at each anchor submission, by submission index. */
  const storesAtSubmit: (Record<string, string> | undefined)[] = [];
  /** Anchor transactions that mined and were then dropped: no finality read ever finds them. */
  const dropped = new Set<string>();
  let account = agentAccount;
  let finalityWaits = 0;
  // Waits run genesis, then the rebind, then the revocation.
  const interruptAt = options.interruptWait === undefined ? undefined : { rebind: 2, revocation: 3 }[options.interruptWait];
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
          storesAtSubmit.push(existsSync(configPath)
            ? (JSON.parse(readFileSync(configPath, 'utf-8')) as { identityStores: Record<string, string> }).identityStores
            : undefined);
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
          if (finalityWaits === interruptAt) throw new Error(`killed during the ${options.interruptWait} finality wait`);
          // The chain's record of the transaction the locator names, as the production reader
          // returns it, rather than what the locator says about it.
          const mined = submitted.find(({ transactionHash }) => transactionHash === input.locator.transactionHash);
          if (mined === undefined || mined.digest !== input.digest || dropped.has(mined.transactionHash)) {
            throw new Error(`anchor ${input.digest} did not read back finalized within ${input.timeoutMs}ms`);
          }
          return {
            digest: mined.digest,
            anchorTime: mined.anchorTime,
            chainId: 84532,
            transactionHash: mined.transactionHash,
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
    configPath,
    catalogPath: join(dir, 'trust.json'),
    authorityStore: join(home, '.jinn-ceremony', 'authority.enc.json'),
    deps,
    calls,
    submitted,
    storesAtSubmit,
    dropped,
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

async function provisioned(options: HarnessOptions = {}): Promise<Harness> {
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
      async lookupFinalizedAnchor({ digest, locator }) {
        const found = h.submitted.find((anchor) => anchor.transactionHash === locator.transactionHash);
        if (found === undefined || found.digest !== digest || h.dropped.has(found.transactionHash)) return null;
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

/** Opens a solver store as the daemon does at boot, against the catalog at `at`. */
async function bootAt(h: Harness, storePath: string, at: string) {
  const trust = await openCatalog(h, at);
  return openRoleIdentitySet({
    agent: config(h).agentIri,
    requiredRoles: SOLVER_ROLES,
    storePath,
    password: PASSWORD,
    bindingResolver: trust.bindingResolver,
    revocationAuthority: trust,
    verifyRoleBinding: trust.verifyRoleBinding,
    now: () => new Date(at),
  });
}

function rotationReceipt(h: Harness): Record<string, unknown> {
  return JSON.parse(readFileSync(join(h.dir, 'ceremony', 'rotation.json'), 'utf-8'));
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

  it('resumes an interruption in the revocation wait onto the anchor it recorded, not a second one', async () => {
    const h = await provisioned({ interruptWait: 'revocation' });
    const retiredStore = config(h).identityStores.solver!;
    await expect(run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']))
      .rejects.toThrow(/killed during the revocation finality wait/u);
    const newStore = (rotationReceipt(h).stores as Record<string, string>).solver!;
    const [, rebind, revocation] = h.submitted;
    // The rebind landed, so the config already names the new store, whose keys boot; nothing is revoked yet.
    expect(config(h).identityStores.solver).toBe(newStore);
    await expect(bootAt(h, newStore, rebind!.anchorTime)).resolves.toBeDefined();
    const afterRebind = catalogBindings(h).length;

    const result = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);

    expect(result.kind).toBe('ceremony_rotate_complete');
    expect(result.resumed).toBe(true);
    expect(result.rebindAnchor).toBeNull();
    // genesis, the rebind, and the revocation: the re-run waits on the recorded anchor and sends none.
    expect(h.submitted).toHaveLength(3);
    expect(result.revocationAnchor).toMatchObject({
      transactionHash: revocation!.transactionHash,
      effectiveTime: revocation!.anchorTime,
    });
    expect(config(h).identityStores.solver).toBe(newStore);
    expect(catalogBindings(h)).toHaveLength(afterRebind);
    await expect(bootAt(h, retiredStore, revocation!.anchorTime)).rejects.toThrow(/binding is revoked at boot/u);
    await expect(bootAt(h, newStore, revocation!.anchorTime)).resolves.toBeDefined();
  });

  it('resumes an interruption in the rebind wait onto the anchor it recorded, not a second one', async () => {
    const h = await provisioned({ interruptWait: 'rebind' });
    const retiredStore = config(h).identityStores.solver!;
    await expect(run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']))
      .rejects.toThrow(/killed during the rebind finality wait/u);
    const [, rebind] = h.submitted;
    // Nothing landed: the config still names the retiring store, and nothing revokes it.
    expect(config(h).identityStores.solver).toBe(retiredStore);

    const result = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);

    expect(result.kind).toBe('ceremony_rotate_complete');
    expect(result.resumed).toBe(true);
    expect(result.rebindAnchor).toMatchObject({ transactionHash: rebind!.transactionHash, validFrom: rebind!.anchorTime });
    // genesis, the rebind, and the revocation.
    expect(h.submitted).toHaveLength(3);
    expect(config(h).identityStores.solver).toBe((rotationReceipt(h).stores as Record<string, string>).solver);
  });

  it('repoints identityStores after the rebind lands and before the revocation is anchored', async () => {
    const h = await provisioned();
    const retiredStore = config(h).identityStores.solver!;

    await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);

    // Submissions run genesis, the rebind, then the revocation. The config names the retiring store
    // until the replacement is bound, and the new one before anything is revoked, so no step leaves
    // it naming a store whose bindings the catalog revokes.
    expect(h.storesAtSubmit[1]!.solver).toBe(retiredStore);
    expect(h.storesAtSubmit[2]!.solver).toBe(config(h).identityStores.solver);
    expect(config(h).identityStores.solver).not.toBe(retiredStore);
  });

  it.each([
    ['as rotate writes it', (receipt: Record<string, unknown>) => receipt],
    [
      'as the first rotate wrote it, naming only the new stores',
      ({ schemaVersion, roleSets, stores }: Record<string, unknown>) => ({ schemaVersion, roleSets, stores }),
    ],
  ])('starts no second rotation when a finished receipt lost its completion mark (%s)', async (_shape, shape) => {
    const h = await provisioned();
    await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);
    // The process stopped after the last write but before the receipt was marked complete.
    const { completedAt, ...unmarked } = rotationReceipt(h);
    expect(completedAt).toEqual(expect.any(String));
    writeFileSync(join(h.dir, 'ceremony', 'rotation.json'), JSON.stringify(shape(unmarked)));
    const stores = config(h).identityStores;
    const submissions = h.submitted.length;
    const catalog = readFileSync(h.catalogPath);

    const result = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);

    expect(result.kind).toBe('ceremony_rotate_complete');
    expect(result.rebindAnchor).toBeNull();
    expect(result.revocationAnchor).toBeNull();
    expect(result.storesCreated).toEqual([]);
    expect(h.submitted).toHaveLength(submissions);
    expect(readFileSync(h.catalogPath)).toEqual(catalog);
    expect(config(h).identityStores).toEqual(stores);
    expect(rotationReceipt(h).completedAt).toEqual(expect.any(String));
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

/**
 * Re-authoring after a rotation (#5308): the catalog is moved aside and `init` runs again over the
 * same directory. Sealed without the catalog it replaces, the new one held no revocations and every
 * key the rotation retired bound again. `init` also opens the stores at their original paths, which
 * after a rotation hold the retired keys.
 */
describe('ceremony init re-authoring a rotated operator', () => {
  async function rotatedAndMovedAside() {
    const h = await provisioned();
    const rotation = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);
    expect(rotation.kind).toBe('ceremony_rotate_complete');
    const previousPath = join(h.home, 'trust.previous.json');
    renameSync(h.catalogPath, previousPath);
    const { revocations } = JSON.parse(readFileSync(previousPath, 'utf-8')) as { revocations: { digest: string }[] };
    expect(revocations).toHaveLength(SOLVER_ROLES.length);
    return { h, previousPath, revocations };
  }

  const reauthorArgv = (h: Harness, extra: readonly string[] = []) => [
    'init', '--dir', h.dir, '--role-sets', 'requester,admission,solver', '--authority-store', h.authorityStore,
    '--execute', ...extra,
  ];

  it('refuses to replace the catalog without --previous-catalog, which would drop its revocations', async () => {
    const { h } = await rotatedAndMovedAside();
    const sessions = h.calls.filter((call) => call === 'openAnchorSession').length;

    const refusal = await run(h, reauthorArgv(h));

    expect(refusal.code).toBe('invalid_invocation');
    expect((refusal.details as { state: string }).state).toBe('previous-catalog-required');
    expect(String(refusal.hint)).toContain('--previous-catalog');
    expect(existsSync(h.catalogPath)).toBe(false);
    expect(h.calls.filter((call) => call === 'openAnchorSession')).toHaveLength(sessions);
  });

  it('refuses, naming the revocation, to bind the retired keys again, before any anchor or write', async () => {
    const { h, previousPath, revocations } = await rotatedAndMovedAside();
    const sessions = h.calls.filter((call) => call === 'openAnchorSession').length;

    const refusal = await run(h, reauthorArgv(h, ['--previous-catalog', previousPath]));

    expect(refusal.code).toBe('invalid_invocation');
    expect((refusal.details as { state: string }).state).toBe('retired-key-bound');
    expect(revocations.some(({ digest }) => String(refusal.message).includes(`revocation ${digest} retired key`))).toBe(true);
    expect(existsSync(h.catalogPath)).toBe(false);
    expect(h.calls.filter((call) => call === 'openAnchorSession')).toHaveLength(sessions);
  });

  it('refuses a --previous-catalog copy taken before the rotation, which holds none of its revocations', async () => {
    const h = await provisioned();
    const stale = join(h.home, 'trust.before-rotation.json');
    copyFileSync(h.catalogPath, stale);
    const rotation = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);
    expect(rotation.kind).toBe('ceremony_rotate_complete');
    renameSync(h.catalogPath, join(h.home, 'trust.previous.json'));
    const sessions = h.calls.filter((call) => call === 'openAnchorSession').length;

    const refusal = await run(h, reauthorArgv(h, ['--previous-catalog', stale]));

    expect(refusal.code).toBe('invalid_invocation');
    expect((refusal.details as { state: string }).state).toBe('rotated-family');
    expect(existsSync(h.catalogPath)).toBe(false);
    expect(h.calls.filter((call) => call === 'openAnchorSession')).toHaveLength(sessions);
  });

  it('refuses a family whose rotation is unfinished, which the config still names, from the rotation receipt', async () => {
    const h = await provisioned({ interruptWait: 'rebind' });
    const retiringStore = config(h).identityStores.solver!;
    await expect(run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']))
      .rejects.toThrow(/killed during the rebind finality wait/u);
    // The rotation is unfinished: the config still names the store it is retiring, so only the
    // receipt says the solver keys are on their way out.
    expect(config(h).identityStores.solver).toBe(retiringStore);
    const previousPath = join(h.home, 'trust.previous.json');
    renameSync(h.catalogPath, previousPath);
    const sessions = h.calls.filter((call) => call === 'openAnchorSession').length;

    const refusal = await run(h, reauthorArgv(h, ['--previous-catalog', previousPath]));

    expect(refusal.code).toBe('invalid_invocation');
    expect((refusal.details as { state: string }).state).toBe('rotated-family');
    expect(String(refusal.message)).toContain(join(h.dir, 'ceremony', 'rotation.json'));
    expect(existsSync(h.catalogPath)).toBe(false);
    expect(h.calls.filter((call) => call === 'openAnchorSession')).toHaveLength(sessions);
  });
});

/**
 * Joining another catalog after a rotation (#5327). `join` opens the stores at
 * `<dir>/identity/<family>.enc.json`, and after a rotation those hold the keys it retired. A join
 * into a catalog at another path bound them there and pointed `identityStores` back at them.
 */
describe('ceremony join after a rotation', () => {
  /** A second catalog, sealed at another path by another operator under the same catalog authority. */
  async function secondCatalog(h: Harness): Promise<{ readonly path: string; readonly genesis: string }> {
    const otherDir = join(h.home, '.jinn-operator-b');
    mkdirSync(otherDir, { recursive: true });
    const init = await run(h, [
      'init', '--dir', otherDir, '--role-sets', 'requester,admission,solver', '--authority-store', h.authorityStore,
      '--execute',
    ]);
    expect(init.kind).toBe('ceremony_init_complete');
    return { path: join(otherDir, 'trust.json'), genesis: String(init.policyGenesisDigest) };
  }

  const joinArgv = (h: Harness, second: { readonly path: string; readonly genesis: string }, roleSets: string) => [
    'join', '--dir', h.dir, '--role-sets', roleSets, '--catalog', second.path, '--genesis', second.genesis,
    '--authority-store', h.authorityStore, '--execute',
  ];

  /** Captures what a refused join must leave as it was: no anchor session, no catalog or config write. */
  function snapshot(h: Harness, catalogPath: string): () => void {
    const sessions = h.calls.filter((call) => call === 'openAnchorSession').length;
    const submissions = h.submitted.length;
    const catalog = readFileSync(catalogPath);
    const configBytes = readFileSync(h.configPath);
    return () => {
      expect(h.calls.filter((call) => call === 'openAnchorSession')).toHaveLength(sessions);
      expect(h.submitted).toHaveLength(submissions);
      expect(readFileSync(catalogPath)).toEqual(catalog);
      expect(readFileSync(h.configPath)).toEqual(configBytes);
    };
  }

  it('refuses, before any anchor, to bind a family rotate replaced into a catalog at another path', async () => {
    const h = await provisioned();
    const rotation = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);
    expect(rotation.kind).toBe('ceremony_rotate_complete');
    const second = await secondCatalog(h);
    const unchanged = snapshot(h, second.path);

    const refusal = await run(h, joinArgv(h, second, 'requester,solver'));

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'rotated-family', sideEffects: false });
    expect(String(refusal.message)).toContain('for solver');
    unchanged();
  });

  it('refuses a family whose rotation is unfinished, which the config still names, from the rotation receipt', async () => {
    const h = await provisioned({ interruptWait: 'rebind' });
    const retiringStore = config(h).identityStores.solver!;
    await expect(run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']))
      .rejects.toThrow(/killed during the rebind finality wait/u);
    expect(config(h).identityStores.solver).toBe(retiringStore);
    const second = await secondCatalog(h);
    const unchanged = snapshot(h, second.path);

    const refusal = await run(h, joinArgv(h, second, 'requester,solver'));

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'rotated-family', sideEffects: false });
    expect(String(refusal.message)).toContain(join(h.dir, 'ceremony', 'rotation.json'));
    unchanged();
  });

  it('refuses, rather than guess, when the rotation receipt cannot be read', async () => {
    const h = await provisioned({ interruptWait: 'rebind' });
    await expect(run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']))
      .rejects.toThrow(/killed during the rebind finality wait/u);
    const receiptPath = join(h.dir, 'ceremony', 'rotation.json');
    // Truncated mid-write: the config still names the store being retired, and only this file says so.
    writeFileSync(receiptPath, '{"schemaVersion":1,"roleSe');
    const second = await secondCatalog(h);
    const unchanged = snapshot(h, second.path);

    const refusal = await run(h, joinArgv(h, second, 'requester,solver'));

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'rotation-receipt-unreadable', sideEffects: false });
    expect(String(refusal.message)).toContain(receiptPath);
    expect(String(refusal.message)).toContain('refuses rather than guess');
    unchanged();
  });

  it('says so when the config names a rotated store and no rotation receipt exists', async () => {
    const h = await provisioned();
    await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);
    renameSync(join(h.dir, 'ceremony', 'rotation.json'), join(h.home, 'rotation.set-aside.json'));
    const second = await secondCatalog(h);
    const unchanged = snapshot(h, second.path);

    const refusal = await run(h, joinArgv(h, second, 'requester,solver'));

    expect(refusal.details).toMatchObject({ state: 'rotated-family', sideEffects: false });
    expect(String(refusal.message)).toContain(`${join(h.dir, 'ceremony', 'rotation.json')} does not exist`);
    unchanged();
  });

  it('refuses in the plan as well, so the plan never lists a retired store to bind', async () => {
    const h = await provisioned();
    await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);
    const second = await secondCatalog(h);
    const unchanged = snapshot(h, second.path);

    const refusal = await run(h, joinArgv(h, second, 'requester,solver').filter((arg) => arg !== '--execute'));

    expect(refusal.details).toMatchObject({ state: 'rotated-family', sideEffects: false });
    unchanged();
  });

  it('still joins a family no rotation touched, binding the keys of the store the config names for it', async () => {
    const h = await provisioned();
    await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);
    const rotatedSolver = config(h).identityStores.solver!;
    const second = await secondCatalog(h);

    const result = await run(h, joinArgv(h, second, 'requester'));

    expect(result.kind).toBe('ceremony_join_complete');
    const requester = await openRoleSigners({
      storePath: config(h).identityStores.requester!,
      password: PASSWORD,
      ownedRoles: orderedRolesForSet('requester'),
      create: false,
    });
    expect((result.bindings as { keyId: string }[]).map(({ keyId }) => keyId).sort())
      .toEqual([...requester.values()].map(({ keyId }) => keyId).sort());
    expect(config(h).identityStores.solver).toBe(rotatedSolver);
  });
});

/**
 * A lost, unreadable or stale rotation receipt (#5329). From the config repoint on, `rotation.json`
 * is the only record of the store a rotation retires: the config names the store it just bound. A
 * receipt read as absent made the next run rotate those keys and leave the retiring ones bound.
 */
describe('ceremony rotate and its rotation receipt', () => {
  const rotateArgv = (h: Harness, extra: readonly string[] = []) => [
    'rotate', '--dir', h.dir, '--role-sets', 'solver', ...extra,
  ];
  const receiptPathOf = (h: Harness) => join(h.dir, 'ceremony', 'rotation.json');

  afterEach(() => {
    diskFull.path = undefined;
    diskFull.fired = false;
    vi.useRealTimers();
  });

  /**
   * Moves the clock a minute on. A rotated store's name carries the second its rotation started, so
   * a rotation started in the same second as the last one would name that one's store.
   */
  function aMinuteLater(): void {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
  }

  /** A solver rotation stopped in its revocation finality wait, after the config was repointed. */
  async function stoppedAfterRepoint(): Promise<Harness> {
    const h = await provisioned({ interruptWait: 'revocation' });
    await expect(run(h, rotateArgv(h, ['--execute']))).rejects.toThrow(/killed during the revocation finality wait/u);
    expect(config(h).identityStores.solver).toBe((rotationReceipt(h).stores as Record<string, string>).solver);
    return h;
  }

  /** What a refused rotate must leave as it was: no session, no anchor, no store, no write. */
  function unchangedBy(h: Harness): () => void {
    const sessions = h.calls.filter((call) => call === 'openAnchorSession').length;
    const submissions = h.submitted.length;
    const catalog = readFileSync(h.catalogPath);
    const configBytes = readFileSync(h.configPath);
    const stores = readdirSync(join(h.dir, 'identity')).sort();
    const receipt = existsSync(receiptPathOf(h)) ? readFileSync(receiptPathOf(h)) : undefined;
    return () => {
      expect(h.calls.filter((call) => call === 'openAnchorSession')).toHaveLength(sessions);
      expect(h.submitted).toHaveLength(submissions);
      expect(readFileSync(h.catalogPath)).toEqual(catalog);
      expect(readFileSync(h.configPath)).toEqual(configBytes);
      expect(readdirSync(join(h.dir, 'identity')).sort()).toEqual(stores);
      expect(existsSync(receiptPathOf(h)) ? readFileSync(receiptPathOf(h)) : undefined).toEqual(receipt);
    };
  }

  it.each([
    ['truncated mid-write', () => '{"schemaVersion":1,"roleSe'],
    ['parseable but naming no stores', (receipt: Record<string, unknown>) => JSON.stringify({ ...receipt, stores: undefined })],
    ['parseable but with null stores', (receipt: Record<string, unknown>) => JSON.stringify({ ...receipt, stores: null })],
  ])('refuses a rotation.json it cannot read (%s), naming it, before anything is minted or anchored', async (_case, corrupt) => {
    const h = await stoppedAfterRepoint();
    writeFileSync(receiptPathOf(h), corrupt(rotationReceipt(h)));
    const unchanged = unchangedBy(h);

    const refusal = await run(h, rotateArgv(h, ['--execute']));

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'rotation-receipt-unreadable', sideEffects: false });
    expect(String(refusal.message)).toContain(receiptPathOf(h));
    unchanged();
  });

  it('refuses an unreadable rotation.json in the plan as well', async () => {
    const h = await stoppedAfterRepoint();
    writeFileSync(receiptPathOf(h), '{"schemaVersion":1,"roleSe');
    const unchanged = unchangedBy(h);

    const refusal = await run(h, rotateArgv(h));

    expect(refusal.details).toMatchObject({ state: 'rotation-receipt-unreadable', sideEffects: false });
    unchanged();
  });

  it('leaves rotation.json whole when a write of it fails partway, and the re-run resumes from it', async () => {
    const h = await stoppedAfterRepoint();
    const retiredStore = (rotationReceipt(h).retiring as Record<string, string>).solver!;
    const before = readFileSync(receiptPathOf(h));
    // The disk fills during the re-run's first write, which rewrites the receipt it resumes.
    diskFull.path = receiptPathOf(h);

    await expect(run(h, rotateArgv(h, ['--execute']))).rejects.toThrow(/ENOSPC/u);

    expect(diskFull.fired).toBe(true);
    expect(readFileSync(receiptPathOf(h))).toEqual(before);
    expect(readdirSync(join(h.dir, 'ceremony')).sort()).toEqual(['receipt.json', 'rotation.json']);
    expect(h.submitted).toHaveLength(3);

    const result = await run(h, rotateArgv(h, ['--execute']));

    expect(result.kind).toBe('ceremony_rotate_complete');
    expect(result.resumed).toBe(true);
    expect(h.submitted).toHaveLength(3);
    await expect(bootAt(h, retiredStore, h.submitted[2]!.anchorTime)).rejects.toThrow(/binding is revoked at boot/u);
  });

  it('refuses to start a rotation, before any anchor, while another key for one of its roles is bound and unrevoked', async () => {
    const h = await stoppedAfterRepoint();
    const retiringStore = (rotationReceipt(h).retiring as Record<string, string>).solver!;
    const stillBound = await openRoleSigners({
      storePath: retiringStore, password: PASSWORD, ownedRoles: SOLVER_ROLES, create: false,
    });
    // Removed after the repoint: the config names the store the rotation just bound, and the
    // catalog still binds the keys it was retiring.
    rmSync(receiptPathOf(h));
    const unchanged = unchangedBy(h);
    aMinuteLater();

    const refusal = await run(h, rotateArgv(h, ['--execute']));

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'another-key-bound', sideEffects: false });
    for (const { keyId } of stillBound.values()) expect(String(refusal.message)).toContain(keyId);
    expect(String(refusal.hint)).toContain(receiptPathOf(h));
    unchanged();
  });

  it('starts a second rotation of a family once the first finished, whose retired keys stay bound but revoked', async () => {
    const h = await provisioned();
    const first = await run(h, rotateArgv(h, ['--execute']));
    expect(first.kind).toBe('ceremony_rotate_complete');
    const firstStore = config(h).identityStores.solver!;
    aMinuteLater();

    const second = await run(h, rotateArgv(h, ['--execute']));

    expect(second.kind).toBe('ceremony_rotate_complete');
    expect(second.resumed).toBe(false);
    expect(h.submitted).toHaveLength(5);
    const revokedAt = h.submitted[4]!.anchorTime;
    await expect(bootAt(h, firstStore, revokedAt)).rejects.toThrow(/binding is revoked at boot/u);
    await expect(bootAt(h, config(h).identityStores.solver!, revokedAt)).resolves.toBeDefined();
  });

  /**
   * A rotated store's name carries the UTC second its rotation read off the clock, so two rotations
   * of a family within one second name one store (#5345). These tests use the real clock, with no
   * fake one: `inOneSecond` starts `act` as a second turns and keeps its result only when `act`
   * finished within that second, so every rotation in it read the same second.
   */
  const nextSecond = () => new Promise((resolve) => { setTimeout(resolve, 1_000 - (Date.now() % 1_000)); });
  async function inOneSecond<T>(prepare: () => Promise<Harness>, act: (h: Harness) => Promise<T>): Promise<T> {
    // A slow machine can let the second turn during `act`; each try starts from a fresh operator.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const h = await prepare();
      await nextSecond();
      const second = Math.floor(Date.now() / 1_000);
      const result = await act(h);
      if (Math.floor(Date.now() / 1_000) === second) return result;
    }
    throw new Error('five tries could not fit the rotations into one second of the real clock');
  }
  const keyIdsOf = (result: Record<string, unknown>, field: 'bindings' | 'retired') =>
    (result[field] as { keyId: string }[]).map(({ keyId }) => keyId).sort();

  it('refuses a rotation started in the same second as the one whose store the config names, rather than retire nothing', async () => {
    const { h, first, firstStore, plan, second, unchanged } = await inOneSecond(() => provisioned(), async (h) => {
      const first = await run(h, rotateArgv(h, ['--execute']));
      const firstStore = config(h).identityStores.solver!;
      const unchanged = unchangedBy(h);
      const plan = await run(h, rotateArgv(h));
      const second = await run(h, rotateArgv(h, ['--execute']));
      return { h, first, firstStore, plan, second, unchanged };
    });

    expect(first.kind).toBe('ceremony_rotate_complete');
    // The second rotation's new store would be the first one's, which the config names and the
    // second would retire. It refuses, in the plan as well, before anything is minted or anchored.
    for (const refusal of [plan, second]) {
      expect(refusal).toMatchObject({
        code: 'invalid_invocation',
        details: { state: 'new-store-exists', sideEffects: false },
      });
      expect(String(refusal.message)).toContain(`${firstStore}, but a file is already there, the store this rotation would retire`);
    }
    unchanged();
    expect(createCeremonyCommand(h.deps).helpText).toContain('new-store-exists');

    // The first rotation's keys are still bound, and a rotation started in a later second retires them.
    await nextSecond();
    const third = await run(h, rotateArgv(h, ['--execute']));
    expect(third.kind).toBe('ceremony_rotate_complete');
    expect(keyIdsOf(third, 'retired')).toEqual(keyIdsOf(first, 'bindings'));
    const revokedAt = h.submitted[h.submitted.length - 1]!.anchorTime;
    await expect(bootAt(h, firstStore, revokedAt)).rejects.toThrow(/binding is revoked at boot/u);
    await expect(bootAt(h, config(h).identityStores.solver!, revokedAt)).resolves.toBeDefined();
  });

  it('refuses to take a store already at its new store\'s path, as after the clock steps back, rather than revoke the keys the config names', async () => {
    // A rotation in an earlier second retired the keys of the store init minted.
    const rotatedOnce = async () => {
      const h = await provisioned();
      expect((await run(h, rotateArgv(h, ['--execute']))).kind).toBe('ceremony_rotate_complete');
      return h;
    };
    const { h, target, refusal, unchanged } = await inOneSecond(rotatedOnce, async (h) => {
      const target = ((await run(h, rotateArgv(h))).newStores as Record<string, string>).solver!;
      // As after the clock steps back to the second an earlier rotation started in: a store of that
      // rotation's, holding keys a rotation retired, is at the path this rotation names.
      copyFileSync((rotationReceipt(h).retiring as Record<string, string>).solver!, target);
      const unchanged = unchangedBy(h);
      const refusal = await run(h, rotateArgv(h, ['--execute']));
      return { h, target, refusal, unchanged };
    });

    expect(refusal).toMatchObject({ code: 'invalid_invocation', details: { state: 'new-store-exists', sideEffects: false } });
    expect(String(refusal.message)).toContain(`${target}, but a file is already there.`);
    unchanged();
    await expect(bootAt(h, config(h).identityStores.solver!, h.submitted[h.submitted.length - 1]!.anchorTime))
      .resolves.toBeDefined();
  });

  it('refuses, rather than report a rotation that retired nothing, when the store the config names is gone from the path its new store would take', async () => {
    const { first, firstStore, refusal, unchanged } = await inOneSecond(() => provisioned(), async (h) => {
      const first = await run(h, rotateArgv(h, ['--execute']));
      const firstStore = config(h).identityStores.solver!;
      // The store the first rotation minted is lost in the same second.
      rmSync(firstStore);
      const unchanged = unchangedBy(h);
      const refusal = await run(h, rotateArgv(h, ['--execute']));
      return { first, firstStore, refusal, unchanged };
    });

    expect(first.kind).toBe('ceremony_rotate_complete');
    expect(refusal.code).toBe('invalid_invocation');
    expect(String(refusal.message)).toContain(`the solver store at ${firstStore} could not be opened`);
    unchanged();
  });

  it('takes a resumed act\'s block time from the finality read, not the time its receipt recorded', async () => {
    const h = await stoppedAfterRepoint();
    const retiredStore = (rotationReceipt(h).retiring as Record<string, string>).solver!;
    const [, , revocation] = h.submitted;
    const receipt = rotationReceipt(h) as { revocationAnchor: { locator: { anchorTime: string } } };
    // A day after the block: the retired key would keep verifying until then.
    receipt.revocationAnchor.locator.anchorTime = new Date(Date.parse(revocation!.anchorTime) + 86_400_000).toISOString();
    writeFileSync(receiptPathOf(h), JSON.stringify(receipt));

    const result = await run(h, rotateArgv(h, ['--execute']));

    expect(result.kind).toBe('ceremony_rotate_complete');
    expect(h.submitted).toHaveLength(3);
    expect(result.revocationAnchor).toMatchObject({
      transactionHash: revocation!.transactionHash,
      effectiveTime: revocation!.anchorTime,
    });
    await expect(bootAt(h, retiredStore, revocation!.anchorTime)).rejects.toThrow(/binding is revoked at boot/u);
  });

  it('submits a fresh anchor, recorded in place of the old one, when the recorded one is for another digest', async () => {
    const h = await provisioned({ interruptWait: 'rebind' });
    await expect(run(h, rotateArgv(h, ['--execute']))).rejects.toThrow(/killed during the rebind finality wait/u);
    const [genesis, rebind] = h.submitted;
    // A record for another digest: the genesis anchor, which anchors other keys.
    const { anchorLocator } = JSON.parse(readFileSync(join(h.dir, 'ceremony', 'receipt.json'), 'utf-8')) as {
      anchorLocator: Record<string, unknown>;
    };
    expect(anchorLocator.transactionHash).toBe(genesis!.transactionHash);
    writeFileSync(receiptPathOf(h), JSON.stringify({
      ...rotationReceipt(h),
      rebindAnchor: { digest: genesis!.digest, locator: anchorLocator },
    }));

    const result = await run(h, rotateArgv(h, ['--execute']));

    expect(result.kind).toBe('ceremony_rotate_complete');
    // genesis, the interrupted rebind, a fresh rebind for the digest this run recomputed, the revocation.
    expect(h.submitted).toHaveLength(4);
    const fresh = h.submitted[2]!;
    expect(fresh.digest).toBe(rebind!.digest);
    expect(result.rebindAnchor).toMatchObject({ digest: rebind!.digest, transactionHash: fresh.transactionHash });
    expect(rotationReceipt(h).rebindAnchor).toMatchObject({
      digest: rebind!.digest,
      locator: { transactionHash: fresh.transactionHash },
    });
  });

  it('resubmits, on --resubmit-anchor, a recorded anchor that never reads back finalized, keeping the receipt', async () => {
    const h = await stoppedAfterRepoint();
    const retiredStore = (rotationReceipt(h).retiring as Record<string, string>).solver!;
    const [, , lost] = h.submitted;
    // Mined, then dropped: every re-run waits on it until the finality timeout.
    h.dropped.add(lost!.transactionHash);
    await expect(run(h, rotateArgv(h, ['--execute']))).rejects.toThrow(/did not read back finalized/u);
    expect(h.submitted).toHaveLength(3);
    const { stores, retiring } = rotationReceipt(h);

    const result = await run(h, rotateArgv(h, ['--execute', '--resubmit-anchor']));

    expect(result.kind).toBe('ceremony_rotate_complete');
    expect(result.resumed).toBe(true);
    expect(h.submitted).toHaveLength(4);
    const fresh = h.submitted[3]!;
    expect(fresh.digest).toBe(lost!.digest);
    expect(result.revocationAnchor).toMatchObject({ transactionHash: fresh.transactionHash, effectiveTime: fresh.anchorTime });
    expect(rotationReceipt(h)).toMatchObject({
      stores,
      retiring,
      revocationAnchor: { digest: fresh.digest, locator: { transactionHash: fresh.transactionHash } },
    });
    await expect(bootAt(h, retiredStore, fresh.anchorTime)).rejects.toThrow(/binding is revoked at boot/u);
    expect(createCeremonyCommand(h.deps).helpText).toContain('--resubmit-anchor');
  });

  it('refuses --resubmit-anchor when no rotation is unfinished, rather than start a new one', async () => {
    const h = await provisioned();
    await run(h, rotateArgv(h, ['--execute']));
    const unchanged = unchangedBy(h);

    const refusal = await run(h, rotateArgv(h, ['--execute', '--resubmit-anchor']));

    expect(refusal.code).toBe('invalid_invocation');
    expect(String(refusal.message)).toContain('--resubmit-anchor applies only to an unfinished rotation');
    unchanged();
  });
});
