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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { openRoleSigners, revocationAnchorDigest, scopeForRole } from '@jinn-network/trust-authoring';
import { didPkh, validateKeyBinding, validateRevocation } from '@jinn-network/trust-core';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ceremonyAnchorDigest,
  createCeremonyCommand,
  type CeremonyCommandDeps,
} from '../../src/cli/commands/ceremony.js';
import type { CommandContext } from '../../src/cli/command.js';
import { ROLE_SETS, orderedRolesForSet, type RoleSetName } from '../../src/cli/commands/native-requester.js';
import { openNativeTrustCatalog } from '../../src/daemon/native-trust-catalog.js';
import { openRoleIdentitySet, type NativeRoleIdentityRole } from '../../src/daemon/role-identities.js';

/**
 * A full disk, armed for one write: the next write into a file whose path starts with `path` lands
 * half its bytes and then fails with ENOSPC, as a write that runs out of space does. A write through
 * a descriptor is matched by the path it was opened at. Every other write passes through.
 */
const diskFull = vi.hoisted(() => ({ path: undefined as string | undefined, fired: false }));

/** Armed for one write: after the next write into a file whose path starts with `path`, runs `then`. */
const afterWrite = vi.hoisted(() => ({
  path: undefined as string | undefined,
  then: undefined as ((written: string) => void) | undefined,
}));

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
    if (afterWrite.path !== undefined && path?.startsWith(afterWrite.path) === true) {
      const { then } = afterWrite;
      afterWrite.path = undefined;
      afterWrite.then = undefined;
      then?.(path);
    }
  };
  return { ...actual, openSync, writeFileSync, default: { ...actual, openSync, writeFileSync } };
});

/** Every identity store `openRoleSigners` opens, by path, so a refusal can show it opened none. */
const storesOpened = vi.hoisted(() => [] as string[]);

/** Armed for one call: the next `planRevocation` returns its plan only once `pause` settles. */
const afterPlanRevocation = vi.hoisted(() => ({ pause: undefined as (() => Promise<void>) | undefined }));

vi.mock('@jinn-network/trust-authoring', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@jinn-network/trust-authoring')>();
  const openRoleSigners: typeof actual.openRoleSigners = async (input) => {
    storesOpened.push(input.storePath);
    return actual.openRoleSigners(input);
  };
  const planRevocation: typeof actual.planRevocation = async (input) => {
    const plan = await actual.planRevocation(input);
    const { pause } = afterPlanRevocation;
    afterPlanRevocation.pause = undefined;
    await pause?.();
    return plan;
  };
  return { ...actual, openRoleSigners, planRevocation };
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

async function run(
  h: Harness,
  argv: string[],
  exit: CommandContext['exit'] = () => undefined,
): Promise<Record<string, unknown>> {
  const writes: string[] = [];
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: false,
    writer: { write: (text: string) => { writes.push(text); return true; } },
    exit,
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

/**
 * Rotates the requester family, then the solver family (#5340). The rotation receipt then records only
 * the solver rotation, and a config file `--config` names afresh records neither.
 */
async function rotateRequesterThenSolver(h: Harness): Promise<void> {
  for (const family of ['requester', 'solver']) {
    // eslint-disable-next-line no-await-in-loop -- the second rotation runs after the first.
    const rotation = await run(h, ['rotate', '--dir', h.dir, '--role-sets', family, '--execute']);
    expect(rotation.kind).toBe('ceremony_rotate_complete');
  }
  expect(rotationReceipt(h).roleSets).toEqual(['solver']);
}

/**
 * Rotates the requester family, moves its live rotated store out of `<dir>/identity` to the path `to`
 * gives (which may rename it) and points the config at it, then rotates the solver family (#5362).
 * No store in `<dir>/identity` then shows the requester rotation, and the rotation receipt records only
 * the solver one. Returns where the requester store went.
 */
async function rotateRequesterMovedThenSolver(h: Harness, to: (rotated: string) => string): Promise<string> {
  const first = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'requester', '--execute']);
  expect(first.kind).toBe('ceremony_rotate_complete');
  const rotatedStore = config(h).identityStores.requester!;
  const moved = to(rotatedStore);
  mkdirSync(dirname(moved), { recursive: true });
  renameSync(rotatedStore, moved);
  writeFileSync(h.configPath, JSON.stringify({ ...config(h), identityStores: { ...config(h).identityStores, requester: moved } }));
  const later = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);
  expect(later.kind).toBe('ceremony_rotate_complete');
  expect(readdirSync(join(h.dir, 'identity')).filter((name) => name.startsWith('requester.rotated-'))).toEqual([]);
  expect(rotationReceipt(h).roleSets).toEqual(['solver']);
  return moved;
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

  const reauthorArgv = (h: Harness, extra: readonly string[] = [], roleSets = 'requester,admission,solver') => [
    'init', '--dir', h.dir, '--role-sets', roleSets, '--authority-store', h.authorityStore,
    '--execute', ...extra,
  ];

  it('refuses to replace the catalog without --previous-catalog, which would drop its revocations', async () => {
    const { h } = await rotatedAndMovedAside();
    const sessions = h.calls.filter((call) => call === 'openAnchorSession').length;

    // Only families no rotation replaced: a rotated one is refused before the plan (rotated-family).
    const refusal = await run(h, reauthorArgv(h, [], 'requester,admission'));

    expect(refusal.code).toBe('invalid_invocation');
    expect((refusal.details as { state: string }).state).toBe('previous-catalog-required');
    expect(String(refusal.hint)).toContain('--previous-catalog');
    expect(existsSync(h.catalogPath)).toBe(false);
    expect(h.calls.filter((call) => call === 'openAnchorSession')).toHaveLength(sessions);
  });

  it('refuses, naming the revocation, to bind the retired keys again when no rotation record is left, before any anchor or write', async () => {
    const { h, previousPath, revocations } = await rotatedAndMovedAside();
    // Every record the rotated-family refusal reads is gone: the rotated store is moved out of
    // <dir>/identity, rotation.json and the run receipt are removed, and --config names a new file
    // that carries only the Agent IRIs, so init binds for the same Agents. The carried revocations are
    // what is left to catch the retired keys.
    const setAside = join(h.home, 'set-aside');
    mkdirSync(setAside);
    for (const name of readdirSync(join(h.dir, 'identity')).filter((entry) => entry.startsWith('solver.rotated-'))) {
      renameSync(join(h.dir, 'identity', name), join(setAside, name));
    }
    rmSync(join(h.dir, 'ceremony', 'rotation.json'));
    rmSync(join(h.dir, 'ceremony', 'receipt.json'));
    const freshConfig = join(h.home, 'fresh-config.json');
    writeFileSync(freshConfig, JSON.stringify({ agentIri: config(h).agentIri, admissionAgent: config(h).admissionAgent }));
    const sessions = h.calls.filter((call) => call === 'openAnchorSession').length;

    const refusal = await run(h, reauthorArgv(h, ['--previous-catalog', previousPath, '--config', freshConfig]));

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

  it('refuses, before it opens any store or prints its plan, a family an earlier rotation retired, whatever --config names (#5340)', async () => {
    const h = await provisioned();
    const stale = join(h.home, 'trust.before-rotation.json');
    copyFileSync(h.catalogPath, stale);
    await rotateRequesterThenSolver(h);
    const freshConfig = join(h.home, 'fresh-config.json');
    const freshCatalog = join(h.home, 'fresh-trust.json');
    const argv = [
      'init', '--dir', h.dir, '--config', freshConfig, '--catalog', freshCatalog, '--role-sets', 'requester',
      '--authority-store', h.authorityStore,
    ];
    const sessions = h.calls.filter((call) => call === 'openAnchorSession').length;
    const submissions = h.submitted.length;
    const opened = storesOpened.length;

    // The plan, then --execute with a catalog copy from before either rotation, which holds none of
    // their revocations.
    for (const extra of [[], ['--execute', '--previous-catalog', stale]]) {
      // eslint-disable-next-line no-await-in-loop -- each run is checked before the next.
      const refusal = await run(h, [...argv, ...extra]);
      expect(refusal.code).toBe('invalid_invocation');
      expect(refusal.details).toMatchObject({ state: 'rotated-family', sideEffects: false, families: ['requester'] });
      expect(String(refusal.message)).toContain(join(h.dir, 'identity', 'requester.rotated-'));
    }

    expect(storesOpened).toHaveLength(opened);
    expect(h.calls.filter((call) => call === 'openAnchorSession')).toHaveLength(sessions);
    expect(h.submitted).toHaveLength(submissions);
    expect(existsSync(freshConfig)).toBe(false);
    expect(existsSync(freshCatalog)).toBe(false);
  });

  it('refuses, before it opens any store or prints its plan, a family whose rotated store was moved and renamed out of <dir>/identity, from the catalog revocations (#5362)', async () => {
    const h = await provisioned();
    await rotateRequesterMovedThenSolver(h, () => join(h.home, 'vault', 'requester.enc.json'));
    rmSync(join(h.dir, 'ceremony', 'rotation.json'));
    const freshConfig = join(h.home, 'fresh-config.json');
    const freshCatalog = join(h.home, 'fresh-trust.json');
    const argv = [
      'init', '--dir', h.dir, '--config', freshConfig, '--role-sets', 'requester', '--authority-store', h.authorityStore,
    ];
    const sessions = h.calls.filter((call) => call === 'openAnchorSession').length;
    const submissions = h.submitted.length;
    const opened = storesOpened.length;
    const refusedFrom = (refusal: Record<string, unknown>, catalogPath: string) => {
      expect(refusal.code).toBe('invalid_invocation');
      expect(refusal.details).toMatchObject({ state: 'rotated-family', sideEffects: false, families: ['requester'] });
      expect(String(refusal.message)).toContain(`${catalogPath} revokes`);
      expect(String(refusal.message)).toContain(join(h.dir, 'ceremony', 'receipt.json'));
    };

    // The plan, then --execute, into a catalog at another path: the catalog the run receipt names, where
    // init bound the keys and the rotation revoked them, shows it.
    for (const extra of [[], ['--execute']]) {
      // eslint-disable-next-line no-await-in-loop -- each run is checked before the next.
      refusedFrom(await run(h, [...argv, '--catalog', freshCatalog, ...extra]), h.catalogPath);
    }
    // A re-author at the catalog's own path, with the catalog moved aside: --previous-catalog shows it.
    const previousPath = join(h.home, 'trust.previous.json');
    renameSync(h.catalogPath, previousPath);
    refusedFrom(await run(h, [...argv, '--execute', '--previous-catalog', previousPath]), previousPath);

    expect(storesOpened).toHaveLength(opened);
    expect(h.calls.filter((call) => call === 'openAnchorSession')).toHaveLength(sessions);
    expect(h.submitted).toHaveLength(submissions);
    expect(existsSync(freshConfig)).toBe(false);
    expect(existsSync(freshCatalog)).toBe(false);
    expect(existsSync(h.catalogPath)).toBe(false);
  });

  it('says a config names a store outside <dir>/identity, not that a rotation retired it, when no rotation did', async () => {
    const h = await provisioned();
    const elsewhere = join(h.home, 'elsewhere', 'solver.enc.json');
    writeFileSync(h.configPath, JSON.stringify({ ...config(h), identityStores: { ...config(h).identityStores, solver: elsewhere } }));
    const opened = storesOpened.length;

    const refusal = await run(h, [
      'init', '--dir', h.dir, '--catalog', join(h.home, 'fresh-trust.json'), '--role-sets', 'requester,solver',
      '--authority-store', h.authorityStore,
    ]);

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'store-elsewhere', sideEffects: false, families: ['solver'] });
    expect(String(refusal.message)).toContain(`${elsewhere} for solver`);
    expect(String(refusal.message)).not.toContain('retired');
    expect(storesOpened).toHaveLength(opened);
  });
});

/**
 * Joining another catalog after a rotation (#5327). `join` opens the stores at
 * `<dir>/identity/<family>.enc.json`, and after a rotation those hold the keys it retired. A join
 * into a catalog at another path bound them there and pointed `identityStores` back at them.
 */
describe('ceremony join after a rotation', () => {
  /** A second catalog, sealed at another path by another operator under the same catalog authority. */
  async function secondCatalog(h: Harness, name = '.jinn-operator-b'): Promise<{ readonly path: string; readonly genesis: string }> {
    const otherDir = join(h.home, name);
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

  /**
   * Captures what a refused join must leave as it was: no store opened, no anchor session, no catalog
   * or config write.
   */
  function snapshot(h: Harness, catalogPath: string): () => void {
    const opened = storesOpened.length;
    const sessions = h.calls.filter((call) => call === 'openAnchorSession').length;
    const submissions = h.submitted.length;
    const catalog = readFileSync(catalogPath);
    const configBytes = readFileSync(h.configPath);
    return () => {
      expect(storesOpened).toHaveLength(opened);
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

  it.each([
    ['rotation.json records only the later rotation', (_h: Harness) => undefined],
    ['rotation.json is gone', (h: Harness) => rmSync(join(h.dir, 'ceremony', 'rotation.json'))],
  ])('refuses, before any store or anchor, a family an earlier rotation retired, with --config naming a new file (%s)', async (_case, receipt) => {
    const h = await provisioned();
    await rotateRequesterThenSolver(h);
    receipt(h);
    const second = await secondCatalog(h);
    const unchanged = snapshot(h, second.path);
    const freshConfig = join(h.home, 'fresh-config.json');

    const refusal = await run(h, [...joinArgv(h, second, 'requester'), '--config', freshConfig]);

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'rotated-family', sideEffects: false, families: ['requester'] });
    expect(String(refusal.message)).toContain(join(h.dir, 'identity', 'requester.rotated-'));
    expect(existsSync(freshConfig)).toBe(false);
    unchanged();
    expect(createCeremonyCommand(h.deps).helpText).toContain('<dir>/identity/<family>.rotated-<stamp>.enc.json');
  });

  it('says a config names a store outside <dir>/identity, not that a rotation retired it, when no rotation did', async () => {
    const h = await provisioned();
    const elsewhere = join(h.home, 'elsewhere', 'requester.enc.json');
    writeFileSync(h.configPath, JSON.stringify({ ...config(h), identityStores: { ...config(h).identityStores, requester: elsewhere } }));
    const second = await secondCatalog(h);
    const unchanged = snapshot(h, second.path);

    const refusal = await run(h, joinArgv(h, second, 'requester'));

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'store-elsewhere', sideEffects: false, families: ['requester'] });
    expect(String(refusal.message)).toContain(`${elsewhere} for requester`);
    expect(String(refusal.message)).not.toContain('retired');
    expect(String(refusal.hint)).toContain('since moved or renamed, that family was rotated');
    unchanged();
  });

  it('refuses as rotated-family, not store-elsewhere, a family whose rotated store was moved out of <dir>/identity and the config names', async () => {
    const h = await provisioned();
    const first = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'requester', '--execute']);
    expect(first.kind).toBe('ceremony_rotate_complete');
    // The live rotated store, moved out of <dir>/identity, with the config pointed at its new path.
    const rotatedStore = config(h).identityStores.requester!;
    const moved = join(h.home, 'moved', basename(rotatedStore));
    mkdirSync(dirname(moved));
    renameSync(rotatedStore, moved);
    writeFileSync(h.configPath, JSON.stringify({ ...config(h), identityStores: { ...config(h).identityStores, requester: moved } }));
    // A later rotation of another family: rotation.json no longer records requester.
    const later = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);
    expect(later.kind).toBe('ceremony_rotate_complete');
    expect(rotationReceipt(h).roleSets).toEqual(['solver']);
    const second = await secondCatalog(h);
    const unchanged = snapshot(h, second.path);

    const refusal = await run(h, joinArgv(h, second, 'requester'));

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'rotated-family', sideEffects: false, families: ['requester'] });
    expect(String(refusal.message)).toContain(moved);
    unchanged();
  });

  it.each([
    ['rotation.json records only the later rotation', (_h: Harness) => undefined],
    ['rotation.json is gone', (h: Harness) => rmSync(join(h.dir, 'ceremony', 'rotation.json'))],
  ])('refuses, before any store or anchor, a family whose rotated store was moved out of <dir>/identity, with --config naming a new file (#5362, %s)', async (_case, receipt) => {
    const h = await provisioned();
    await rotateRequesterMovedThenSolver(h, (rotated) => join(h.home, 'moved', basename(rotated)));
    receipt(h);
    const second = await secondCatalog(h);
    const unchanged = snapshot(h, second.path);
    const freshConfig = join(h.home, 'fresh-config.json');

    const refusal = await run(h, [...joinArgv(h, second, 'requester'), '--config', freshConfig]);

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'rotated-family', sideEffects: false, families: ['requester'] });
    // The catalog the run receipt names, where the keys were bound and the rotation revoked them.
    expect(String(refusal.message)).toContain(`${h.catalogPath} revokes`);
    expect(String(refusal.message)).toContain(join(h.dir, 'ceremony', 'receipt.json'));
    expect(existsSync(freshConfig)).toBe(false);
    unchanged();
  });

  it('refuses as rotated-family, not store-elsewhere, a family whose rotated store was renamed when moved and the config names (#5362)', async () => {
    const h = await provisioned();
    const renamed = await rotateRequesterMovedThenSolver(h, () => join(h.home, 'vault', 'requester.enc.json'));
    expect(config(h).identityStores.requester).toBe(renamed);
    const second = await secondCatalog(h);
    const unchanged = snapshot(h, second.path);

    const refusal = await run(h, joinArgv(h, second, 'requester'));

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'rotated-family', sideEffects: false, families: ['requester'] });
    expect(String(refusal.message)).toContain(`${h.catalogPath} revokes`);
    unchanged();
    expect(createCeremonyCommand(h.deps).helpText).toContain('the run receipt, <dir>/ceremony/receipt.json, names every anchor');
  });

  it('refuses from the catalog it joins when that is the one the rotation revoked in, moved to another path (#5362)', async () => {
    const h = await provisioned();
    await rotateRequesterMovedThenSolver(h, (rotated) => join(h.home, 'moved', basename(rotated)));
    const genesis = config(h).trustPolicyGenesisDigest;
    const shared = { path: join(h.home, 'shared', 'trust.json'), genesis };
    mkdirSync(dirname(shared.path));
    renameSync(h.catalogPath, shared.path);
    const unchanged = snapshot(h, shared.path);

    const refusal = await run(h, [...joinArgv(h, shared, 'requester'), '--config', join(h.home, 'fresh-config.json')]);

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'rotated-family', sideEffects: false, families: ['requester'] });
    expect(String(refusal.message)).toContain(`${shared.path} revokes`);
    unchanged();
  });

  it('still joins a family whose keys no catalog revokes, into a catalog that revokes another operator\'s keys for it (#5362)', async () => {
    const h = await provisioned();
    const second = await secondCatalog(h);
    const rotation = await run(h, ['rotate', '--dir', dirname(second.path), '--role-sets', 'requester', '--execute']);
    expect(rotation.kind).toBe('ceremony_rotate_complete');

    const result = await run(h, joinArgv(h, second, 'requester'));

    expect(result.kind).toBe('ceremony_join_complete');
  });

  it('refuses a family a rotation retired after a later join replaced the anchor the run receipt names (#5362)', async () => {
    // init binds requester, admission and solver into the first catalog, under one anchor.
    const h = await provisioned();
    expect(Object.keys(JSON.parse(readFileSync(join(h.dir, 'ceremony', 'receipt.json'), 'utf-8')))).not.toContain('earlierAnchors');
    const rotation = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);
    expect(rotation.kind).toBe('ceremony_rotate_complete');
    // A join of requester alone into a second catalog: a new anchor, over the requester keys only.
    const second = await secondCatalog(h);
    const joined = await run(h, joinArgv(h, second, 'requester'));
    expect(joined.kind).toBe('ceremony_join_complete');
    // Then every other record of the solver rotation goes.
    const setAside = join(h.home, 'set-aside');
    mkdirSync(setAside);
    for (const name of readdirSync(join(h.dir, 'identity')).filter((entry) => entry.startsWith('solver.rotated-'))) {
      renameSync(join(h.dir, 'identity', name), join(setAside, name));
    }
    rmSync(join(h.dir, 'ceremony', 'rotation.json'));
    const third = await secondCatalog(h, '.jinn-operator-c');
    const unchanged = snapshot(h, third.path);
    const freshConfig = join(h.home, 'fresh-config.json');

    const refusal = await run(h, [...joinArgv(h, third, 'requester,solver'), '--config', freshConfig]);

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'rotated-family', sideEffects: false, families: ['solver'] });
    expect(String(refusal.message)).toContain(`${h.catalogPath} revokes the solver keys`);
    expect(existsSync(freshConfig)).toBe(false);
    unchanged();
  });

  /**
   * The run receipt after the walk above, up to the later join: the solver keys were bound under the
   * first anchor, which only `earlierAnchors` records, and every other record of their rotation is gone.
   */
  async function rotatedThenJoinedElsewhere(): Promise<{ readonly h: Harness; readonly receipt: Record<string, unknown> }> {
    const h = await provisioned();
    const rotation = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);
    expect(rotation.kind).toBe('ceremony_rotate_complete');
    const joined = await run(h, joinArgv(h, await secondCatalog(h), 'requester'));
    expect(joined.kind).toBe('ceremony_join_complete');
    setSolverRotationAside(h);
    const receipt = runReceipt(h);
    expect(receipt.earlierAnchors).toEqual([{ anchorDigest: h.submitted[0]!.digest, catalogPath: h.catalogPath }]);
    return { h, receipt };
  }

  /** Moves the solver rotated stores out of `<dir>/identity` and removes `rotation.json`. */
  function setSolverRotationAside(h: Harness): void {
    const setAside = join(h.home, 'set-aside');
    mkdirSync(setAside, { recursive: true });
    for (const name of readdirSync(join(h.dir, 'identity')).filter((entry) => entry.startsWith('solver.rotated-'))) {
      renameSync(join(h.dir, 'identity', name), join(setAside, name));
    }
    rmSync(join(h.dir, 'ceremony', 'rotation.json'));
  }

  const runReceiptPath = (h: Harness) => join(h.dir, 'ceremony', 'receipt.json');
  const runReceipt = (h: Harness) => JSON.parse(readFileSync(runReceiptPath(h), 'utf-8')) as Record<string, unknown>;
  const earlierAnchorOf = (receipt: Record<string, unknown>) => (receipt.earlierAnchors as Record<string, unknown>[])[0]!;

  /**
   * Binds requester and solver from `<dir>` into a catalog at a new path, with --config naming a new
   * file: join into a third operator's catalog, or init sealing one. Returns the refusal and a check
   * that nothing was opened, anchored or written.
   */
  async function bindRequesterAndSolver(h: Harness, verb: 'join' | 'init'): Promise<{
    readonly refusal: Record<string, unknown>;
    readonly unchanged: () => void;
  }> {
    const freshConfig = join(h.home, 'fresh-config.json');
    const target = verb === 'join'
      ? await secondCatalog(h, '.jinn-operator-c')
      : { path: join(h.home, 'fresh-trust.json'), genesis: '' };
    const unchangedCatalog = verb === 'join' ? snapshot(h, target.path) : undefined;
    const opened = storesOpened.length;
    const sessions = h.calls.filter((call) => call === 'openAnchorSession').length;
    const submissions = h.submitted.length;
    const configBytes = readFileSync(h.configPath);
    const argv = verb === 'join'
      ? [...joinArgv(h, target, 'requester,solver'), '--config', freshConfig]
      : [
        'init', '--dir', h.dir, '--config', freshConfig, '--catalog', target.path, '--role-sets', 'requester,solver',
        '--authority-store', h.authorityStore, '--execute',
      ];
    const refusal = await run(h, argv);
    return {
      refusal,
      unchanged: () => {
        unchangedCatalog?.();
        expect(storesOpened).toHaveLength(opened);
        expect(h.calls.filter((call) => call === 'openAnchorSession')).toHaveLength(sessions);
        expect(h.submitted).toHaveLength(submissions);
        expect(readFileSync(h.configPath)).toEqual(configBytes);
        expect(existsSync(freshConfig)).toBe(false);
        if (verb === 'init') expect(existsSync(target.path)).toBe(false);
      },
    };
  }

  /** Each way a run receipt can be damaged: what the file then holds, from the receipt it was. */
  const receiptDamage: readonly (readonly [string, (receipt: Record<string, unknown>) => string])[] = [
    ['cannot be parsed', (receipt) => JSON.stringify(receipt).slice(0, 40)],
    ['has no agentIri', (receipt) => JSON.stringify({ ...receipt, agentIri: undefined })],
    ['has an earlierAnchors that is not a list', (receipt) =>
      JSON.stringify({ ...receipt, earlierAnchors: earlierAnchorOf(receipt) })],
    ['has an earlierAnchors entry whose anchorDigest is not a string', (receipt) =>
      JSON.stringify({ ...receipt, earlierAnchors: [{ ...earlierAnchorOf(receipt), anchorDigest: 7 }] })],
    ['has an earlierAnchors entry whose catalogPath is not a string', (receipt) =>
      JSON.stringify({ ...receipt, earlierAnchors: [{ ...earlierAnchorOf(receipt), catalogPath: [String(earlierAnchorOf(receipt).catalogPath)] }] })],
  ];

  it.each(receiptDamage.flatMap(([damage, write]) => (['join', 'init'] as const).map((verb) => [verb, damage, write] as const)))(
    '%s refuses, naming the file, before any store or anchor, a run receipt that %s (#5377)',
    async (verb, _damage, write) => {
      const { h, receipt } = await rotatedThenJoinedElsewhere();
      writeFileSync(runReceiptPath(h), write(receipt));
      const damaged = readFileSync(runReceiptPath(h));

      const { refusal, unchanged } = await bindRequesterAndSolver(h, verb);

      expect(refusal.code).toBe('invalid_invocation');
      expect(refusal.details).toMatchObject({ state: 'run-receipt-unreadable', sideEffects: false });
      expect(String(refusal.message)).toContain(runReceiptPath(h));
      unchanged();
      // Refused rather than rewritten: a later run cannot drop what the damaged file held.
      expect(readFileSync(runReceiptPath(h))).toEqual(damaged);
    },
  );

  it.each(['join', 'init'] as const)(
    '%s refuses a family a rotation retired before a re-author that took the fresh anchor as the runbook describes (#5377)',
    async (verb) => {
      // init binds requester, admission and solver into catalog A, under one anchor; rotate retires solver.
      const h = await provisioned();
      const rotation = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);
      expect(rotation.kind).toBe('ceremony_rotate_complete');
      // The re-author of the families no rotation touched, taking the fresh anchor as
      // docs/runbooks/native-trust-reauthor.md describes: catalog A moved aside, the run receipt left
      // in place.
      const previousPath = join(h.home, 'trust.previous.json');
      renameSync(h.catalogPath, previousPath);
      const reauthor = await run(h, [
        'init', '--dir', h.dir, '--role-sets', 'requester,admission', '--authority-store', h.authorityStore,
        '--previous-catalog', previousPath, '--fresh-anchor', '--execute',
      ]);
      expect(reauthor.kind).toBe('ceremony_init_complete');
      // The new catalog A carries the revoked solver bindings, under the first anchor, which the run
      // receipt still records.
      expect(runReceipt(h).earlierAnchors).toEqual([{ anchorDigest: h.submitted[0]!.digest, catalogPath: h.catalogPath }]);
      setSolverRotationAside(h);

      const { refusal, unchanged } = await bindRequesterAndSolver(h, verb);

      expect(refusal.code).toBe('invalid_invocation');
      expect(refusal.details).toMatchObject({ state: 'rotated-family', sideEffects: false, families: ['solver'] });
      expect(String(refusal.message)).toContain(`${h.catalogPath} revokes the solver keys`);
      unchanged();
    },
  );

  it('takes a fresh anchor on --fresh-anchor for the key set the run receipt names, keeping every anchor it records (#5377)', async () => {
    // init binds into catalog A under one anchor; a join of requester alone into catalog B, under a
    // second anchor, is the one the run receipt names.
    const h = await provisioned();
    const second = await secondCatalog(h);
    const joined = await run(h, joinArgv(h, second, 'requester'));
    expect(joined.kind).toBe('ceremony_join_complete');
    const [first, , joinAnchor] = h.submitted;
    expect(runReceipt(h)).toMatchObject({ anchorDigest: joinAnchor!.digest, catalogPath: second.path });
    const previousPath = join(h.home, 'trust.previous.json');
    renameSync(h.catalogPath, previousPath);
    const submissions = h.submitted.length;

    // A re-author of requester alone recomputes the anchor the run receipt names, which init would reuse.
    const result = await run(h, [
      'init', '--dir', h.dir, '--role-sets', 'requester', '--authority-store', h.authorityStore,
      '--previous-catalog', previousPath, '--fresh-anchor', '--execute',
    ]);

    expect(result).toMatchObject({ kind: 'ceremony_init_complete', anchorReused: false, anchorDigest: joinAnchor!.digest });
    expect(h.submitted).toHaveLength(submissions + 1);
    const fresh = h.submitted[submissions]!;
    expect(fresh.digest).toBe(joinAnchor!.digest);
    expect(runReceipt(h)).toMatchObject({
      anchorDigest: joinAnchor!.digest,
      anchorTransactionHash: fresh.transactionHash,
      catalogPath: h.catalogPath,
      earlierAnchors: [
        { anchorDigest: first!.digest, catalogPath: h.catalogPath },
        { anchorDigest: joinAnchor!.digest, catalogPath: second.path },
      ],
    });
    const help = createCeremonyCommand(h.deps).helpText.replace(/\s+/gu, ' ');
    expect(help).toContain('--fresh-anchor');
    expect(help).toContain('A catalog no longer at the path the run receipt records is not read');
    expect(help).toContain('Moving the run receipt aside drops every anchor it records');
  });

  it('resumes a --fresh-anchor re-author killed in its finality wait onto the anchor it sent, re-run without the flag (#5377)', async () => {
    // The second finality wait is the re-author's: it is killed after its anchor was sent.
    const h = await provisioned({ interruptWait: 'rebind' });
    const previousPath = join(h.home, 'trust.previous.json');
    renameSync(h.catalogPath, previousPath);
    const argv = [
      'init', '--dir', h.dir, '--role-sets', 'requester,admission,solver', '--authority-store', h.authorityStore,
      '--previous-catalog', previousPath, '--execute',
    ];
    await expect(run(h, [...argv, '--fresh-anchor'])).rejects.toThrow(/killed during the rebind finality wait/u);
    expect(h.submitted).toHaveLength(2);
    const sent = h.submitted[1]!;
    expect(runReceipt(h).anchorTransactionHash).toBe(sent.transactionHash);

    const resumed = await run(h, argv);

    expect(resumed).toMatchObject({ kind: 'ceremony_init_complete', anchorReused: true, anchorTransactionHash: sent.transactionHash });
    expect(h.submitted).toHaveLength(2);
    const help = createCeremonyCommand(h.deps).helpText.replace(/\s+/gu, ' ');
    expect(help.slice(help.indexOf('RESUMABLE.'), help.indexOf('RE-AUTHORING.'))).toContain(
      'Resume a --fresh-anchor run interrupted after its anchor was sent without --fresh-anchor: with it, the re-run '
        + 'sends another anchor.',
    );
  });

  it('keeps, for every role family, a role whose scope no other family holds, which is how a revoked binding names it', () => {
    const scopeOf = (role: NativeRoleIdentityRole): string => [...scopeForRole(role)].sort().join(' ');
    const families = Object.keys(ROLE_SETS) as RoleSetName[];
    for (const family of families) {
      const elsewhere = new Set(families.filter((other) => other !== family).flatMap((other) => [...ROLE_SETS[other]].map(scopeOf)));
      expect([...ROLE_SETS[family]].some((role) => !elsewhere.has(scopeOf(role))), family).toBe(true);
    }
  });
});

/**
 * A key a rotation retired, bound again under a new Agent IRI (#5372). With every rotation record and
 * the run receipt gone, the rotated-family refusal sees no rotation, and an init or join whose config
 * carries no agentIri mints new Agent IRIs. The revocations in the catalog it names are what is left,
 * and they retire the key whatever Agent it would be bound to.
 */
describe('ceremony init and join with no record of a rotation left', () => {
  it.each([
    ['a config with no agentIri', (_h: Harness) => undefined],
    ['a config carrying the Agent IRIs', (h: Harness) => ({ agentIri: config(h).agentIri, admissionAgent: config(h).admissionAgent })],
  ])('refuse, before any anchor, to bind a key a revocation in the catalog they name retired, with %s', async (_case, values) => {
    const h = await provisioned();
    const rotation = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute']);
    expect(rotation.kind).toBe('ceremony_rotate_complete');
    const retiredFor = config(h).agentIri;
    // Every rotation record goes: the rotated store leaves <dir>/identity, and rotation.json and the run
    // receipt are removed. The catalog holding the revocations is moved aside, as for a re-author.
    const setAside = join(h.home, 'set-aside');
    mkdirSync(setAside);
    for (const name of readdirSync(join(h.dir, 'identity')).filter((entry) => entry.startsWith('solver.rotated-'))) {
      renameSync(join(h.dir, 'identity', name), join(setAside, name));
    }
    rmSync(join(h.dir, 'ceremony', 'rotation.json'));
    rmSync(join(h.dir, 'ceremony', 'receipt.json'));
    const holding = join(h.home, 'trust.previous.json');
    renameSync(h.catalogPath, holding);
    const { policyGenesisDigest, revocations } = JSON.parse(readFileSync(holding, 'utf-8')) as {
      policyGenesisDigest: string;
      revocations: { digest: string }[];
    };
    expect(revocations).toHaveLength(SOLVER_ROLES.length);
    const freshConfig = join(h.home, 'fresh-config.json');
    const configValues = values(h);
    if (configValues !== undefined) writeFileSync(freshConfig, JSON.stringify(configValues));
    const configBefore = configValues === undefined ? undefined : readFileSync(freshConfig);
    const catalogBefore = readFileSync(holding);
    const common = [
      '--dir', h.dir, '--config', freshConfig, '--role-sets', 'requester,admission,solver', '--authority-store', h.authorityStore,
    ];

    // Without the Agent IRIs, the plan shows init would bind the stores to a new Agent.
    const plan = await run(h, ['init', ...common, '--previous-catalog', holding]);
    expect(plan.kind).toBe('ceremony_init_plan');
    expect(plan.agentIri === retiredFor).toBe(configValues !== undefined);

    const sessions = h.calls.filter((call) => call === 'openAnchorSession').length;
    const submissions = h.submitted.length;
    const refusals = [
      await run(h, ['init', ...common, '--execute', '--previous-catalog', holding]),
      await run(h, ['join', ...common, '--execute', '--catalog', holding, '--genesis', policyGenesisDigest]),
    ];

    for (const refusal of refusals) {
      expect(refusal.code).toBe('invalid_invocation');
      expect(refusal.details).toMatchObject({ state: 'retired-key-bound', sideEffects: false });
      expect(revocations.some(({ digest }) => String(refusal.message).includes(`revocation ${digest} retired key`))).toBe(true);
      expect(String(refusal.message)).toContain(`for ${retiredFor}`);
    }
    expect(h.calls.filter((call) => call === 'openAnchorSession')).toHaveLength(sessions);
    expect(h.submitted).toHaveLength(submissions);
    expect(existsSync(h.catalogPath)).toBe(false);
    expect(readFileSync(holding)).toEqual(catalogBefore);
    if (configBefore === undefined) expect(existsSync(freshConfig)).toBe(false);
    else expect(readFileSync(freshConfig)).toEqual(configBefore);
    expect(createCeremonyCommand(h.deps).helpText).toContain('whatever Agent IRI it would bind the key to');
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

  /**
   * A receipt lost for good after the repoint (#5346). The config names the store the rotation bound,
   * the catalog still binds the keys it was retiring, and the store holding those keys is still on
   * disk, where rotate left it. `--retiring-store` names it, and the catalog must bear it out.
   */
  type Stores = Record<string, string>;
  const storesOf = (h: Harness) => rotationReceipt(h) as { retiring: Stores; stores: Stores };
  const keyIdsIn = async (storePath: string, ownedRoles: readonly NativeRoleIdentityRole[]) =>
    [...(await openRoleSigners({ storePath, password: PASSWORD, ownedRoles, create: false })).values()]
      .map(({ keyId }) => keyId)
      .sort();
  /** Everything a run writes, for a run whose output is text (`--human`). */
  const runHuman = async (h: Harness, argv: string[]): Promise<string> => {
    const writes: string[] = [];
    await createCeremonyCommand(h.deps).run({
      argv,
      stdoutIsTty: false,
      writer: { write: (text: string) => { writes.push(text); return true; } },
      exit: () => undefined,
      env: { HOME: h.home, JINN_PASSWORD: PASSWORD } as NodeJS.ProcessEnv,
    });
    return writes.join('');
  };

  it('finishes, from --retiring-store, a rotation whose receipt was lost after the repoint: the old keys are revoked and the new ones boot', async () => {
    const h = await stoppedAfterRepoint();
    const { retiring, stores } = storesOf(h);
    const retiringKeys = await keyIdsIn(retiring.solver!, SOLVER_ROLES);
    rmSync(receiptPathOf(h));
    aMinuteLater();

    // The refusal a lost receipt meets names the way forward.
    const refusal = await run(h, rotateArgv(h, ['--execute']));
    expect(refusal.details).toMatchObject({ state: 'another-key-bound', sideEffects: false });
    expect(String(refusal.hint)).toContain('--retiring-store <family>=<path>');

    const way = ['--retiring-store', `solver=${retiring.solver}`];
    const plan = await run(h, rotateArgv(h, way));
    expect(plan.kind).toBe('ceremony_rotate_plan');
    expect((plan.retiring as { keyId: string }[]).map(({ keyId }) => keyId).sort()).toEqual(retiringKeys);
    expect(plan.newStores).toEqual({ solver: stores.solver });

    const result = await run(h, rotateArgv(h, ['--execute', ...way]));

    expect(result.kind).toBe('ceremony_rotate_complete');
    expect((result.retired as { keyId: string }[]).map(({ keyId }) => keyId).sort()).toEqual(retiringKeys);
    expect(result.rebindAnchor).toBeNull();
    expect(result.storesCreated).toEqual([]);
    // genesis, the rebind, the revocation anchor the lost receipt recorded, and a fresh one.
    expect(h.submitted).toHaveLength(4);
    const revocation = h.submitted[3]!;
    expect(result.revocationAnchor).toMatchObject({
      transactionHash: revocation.transactionHash,
      effectiveTime: revocation.anchorTime,
    });
    expect(config(h).identityStores.solver).toBe(stores.solver);
    expect(rotationReceipt(h)).toMatchObject({
      roleSets: ['solver'],
      stores: { solver: stores.solver },
      retiring: { solver: retiring.solver },
      completedAt: expect.any(String),
    });
    await expect(bootAt(h, retiring.solver!, revocation.anchorTime)).rejects.toThrow(/binding is revoked at boot/u);
    await expect(bootAt(h, stores.solver!, revocation.anchorTime)).resolves.toBeDefined();
    // Nothing is left bound for the next rotation to refuse on.
    expect((await run(h, rotateArgv(h))).kind).toBe('ceremony_rotate_plan');
    expect(createCeremonyCommand(h.deps).helpText).toContain('--retiring-store <family>=<path>');
  });

  it('refuses a --retiring-store naming the store identityStores names, whose keys the lost rotation just bound', async () => {
    const h = await stoppedAfterRepoint();
    const { stores } = storesOf(h);
    rmSync(receiptPathOf(h));
    const unchanged = unchangedBy(h);

    const refusal = await run(h, rotateArgv(h, ['--execute', '--retiring-store', `solver=${stores.solver}`]));

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'retiring-store-mismatch', sideEffects: false });
    expect(String(refusal.message)).toContain(stores.solver);
    unchanged();
  });

  it('refuses to revoke, by --retiring-store, keys the catalog bound after the ones identityStores names', async () => {
    const h = await stoppedAfterRepoint();
    const { retiring, stores } = storesOf(h);
    rmSync(receiptPathOf(h));
    // The config pointed back at the store being retired, so the keys the lost rotation bound are
    // the ones it does not name.
    writeFileSync(h.configPath, JSON.stringify({
      ...config(h),
      identityStores: { ...config(h).identityStores, solver: retiring.solver },
    }));
    const unchanged = unchangedBy(h);

    const refusal = await run(h, rotateArgv(h, ['--execute', '--retiring-store', `solver=${stores.solver}`]));

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'retiring-store-mismatch', sideEffects: false });
    expect(String(refusal.message)).toContain('no earlier than');
    unchanged();
  });

  it('names the way forward when identityStores was pointed back at the store being retired, and following it finishes the rotation', async () => {
    const h = await stoppedAfterRepoint();
    const { retiring, stores } = storesOf(h);
    rmSync(receiptPathOf(h));
    const pointedBack = { ...config(h), identityStores: { ...config(h).identityStores, solver: retiring.solver } };
    writeFileSync(h.configPath, JSON.stringify(pointedBack));
    const unchanged = unchangedBy(h);

    // Whichever store the flag names, the run refuses, and the hint says what to do.
    for (const named of [stores.solver, retiring.solver]) {
      // eslint-disable-next-line no-await-in-loop -- one refusal after the other.
      const refusal = await run(h, rotateArgv(h, ['--execute', '--retiring-store', `solver=${named}`]));
      expect(refusal.details).toMatchObject({ state: 'retiring-store-mismatch', sideEffects: false });
      expect(String(refusal.hint)).toContain(`If identityStores.<family> in ${h.configPath} was pointed back at the store `
        + 'being retired, point it at the store the lost rotation bound');
      expect(String(refusal.hint)).toContain(join(h.dir, 'identity', '<family>.rotated-<stamp>.enc.json'));
    }
    unchanged();

    writeFileSync(h.configPath, JSON.stringify({ ...pointedBack, identityStores: { ...pointedBack.identityStores, solver: stores.solver } }));
    const result = await run(h, rotateArgv(h, ['--execute', '--retiring-store', `solver=${retiring.solver}`]));

    expect(result.kind).toBe('ceremony_rotate_complete');
    expect(keyIdsOf(result, 'retired')).toEqual(await keyIdsIn(retiring.solver!, SOLVER_ROLES));
    const revokedAt = h.submitted[h.submitted.length - 1]!.anchorTime;
    await expect(bootAt(h, retiring.solver!, revokedAt)).rejects.toThrow(/binding is revoked at boot/u);
    await expect(bootAt(h, stores.solver!, revokedAt)).resolves.toBeDefined();
  });

  it('plans a run from --retiring-store as finishing the lost rotation: it mints no store and sends one anchor', async () => {
    const h = await stoppedAfterRepoint();
    const { retiring, stores } = storesOf(h);
    rmSync(receiptPathOf(h));
    aMinuteLater();
    const way = ['--retiring-store', `solver=${retiring.solver}`];
    const unchanged = unchangedBy(h);

    const plan = await run(h, rotateArgv(h, way));
    const text = await runHuman(h, rotateArgv(h, [...way, '--human']));

    expect(plan).toMatchObject({ kind: 'ceremony_rotate_plan', resuming: false, recovering: true, newStores: { solver: stores.solver } });
    expect(text).toContain('This run finishes a rotation whose rotation.json was lost after it repointed the config.');
    expect(text).toContain('It mints no store');
    expect(text).toContain('One anchor, one finality wait.');
    expect(text).not.toContain('mint the new stores');
    expect(text).not.toContain('Two anchors');
    unchanged();

    // It does what its plan says.
    const result = await run(h, rotateArgv(h, ['--execute', ...way]));
    expect(result.kind).toBe('ceremony_rotate_complete');
    expect(result.storesCreated).toEqual([]);
    expect(h.submitted).toHaveLength(4);

    // A new rotation's plan is as it was.
    const next = await run(h, rotateArgv(h));
    expect(next).toMatchObject({ kind: 'ceremony_rotate_plan', resuming: false, recovering: false });
    expect(await runHuman(h, rotateArgv(h, ['--human']))).toContain('mint the new stores');
  });

  it('refuses when the catalog revokes the keys of the store identityStores names, rather than revoke the only standing ones', async () => {
    const h = await provisioned();
    const first = await run(h, rotateArgv(h, ['--execute']));
    expect(first.kind).toBe('ceremony_rotate_complete');
    const { retiring, stores } = storesOf(h);
    rmSync(receiptPathOf(h));
    // The config pointed back at the store that rotation retired, whose bindings it revoked.
    writeFileSync(h.configPath, JSON.stringify({
      ...config(h),
      identityStores: { ...config(h).identityStores, solver: retiring.solver },
    }));
    const unchanged = unchangedBy(h);

    const refusal = await run(h, rotateArgv(h, ['--execute', '--retiring-store', `solver=${stores.solver}`]));

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'retiring-store-mismatch', sideEffects: false });
    expect(String(refusal.message)).toContain('holds no unrevoked binding');
    unchanged();
  });

  it('refuses while a key the lost rotation was retiring is in no store --retiring-store names, and finishes once each family is named', async () => {
    const h = await provisioned({ interruptWait: 'revocation' });
    await expect(run(h, ['rotate', '--dir', h.dir, '--role-sets', 'requester,solver', '--execute']))
      .rejects.toThrow(/killed during the revocation finality wait/u);
    const { retiring, stores } = storesOf(h);
    const retiringKeys = [
      ...await keyIdsIn(retiring.requester!, orderedRolesForSet('requester')),
      ...await keyIdsIn(retiring.solver!, SOLVER_ROLES),
    ].sort();
    rmSync(receiptPathOf(h));
    const unchanged = unchangedBy(h);

    // The requester discovery role shares its Agent and scope with the solver's, so the requester
    // key that rotation was retiring is still bound, and no named store holds it.
    const partial = await run(h, rotateArgv(h, ['--execute', '--retiring-store', `solver=${retiring.solver}`]));

    expect(partial.code).toBe('invalid_invocation');
    expect(partial.details).toMatchObject({ state: 'another-key-bound', sideEffects: false });
    unchanged();

    const result = await run(h, [
      'rotate', '--dir', h.dir, '--role-sets', 'requester,solver', '--execute',
      '--retiring-store', `requester=${retiring.requester}`, '--retiring-store', `solver=${retiring.solver}`,
    ]);

    expect(result.kind).toBe('ceremony_rotate_complete');
    expect((result.retired as { keyId: string }[]).map(({ keyId }) => keyId).sort()).toEqual(retiringKeys);
    expect(config(h).identityStores).toMatchObject({ requester: stores.requester, solver: stores.solver });
    const revokedAt = h.submitted[3]!.anchorTime;
    await expect(bootAt(h, retiring.solver!, revokedAt)).rejects.toThrow(/binding is revoked at boot/u);
    await expect(bootAt(h, stores.solver!, revokedAt)).resolves.toBeDefined();
  });

  it('refuses a --retiring-store whose keys the catalog already revokes: there is nothing to finish', async () => {
    const h = await provisioned();
    const first = await run(h, rotateArgv(h, ['--execute']));
    expect(first.kind).toBe('ceremony_rotate_complete');
    const { retiring } = storesOf(h);
    rmSync(receiptPathOf(h));
    const unchanged = unchangedBy(h);

    const refusal = await run(h, rotateArgv(h, ['--execute', '--retiring-store', `solver=${retiring.solver}`]));

    expect(refusal.code).toBe('invalid_invocation');
    expect(String(refusal.message)).toContain('nothing to finish');
    unchanged();
  });

  it('resumes an unfinished receipt with --retiring-store naming the store it retires, and refuses another store', async () => {
    const h = await stoppedAfterRepoint();
    const { retiring, stores } = storesOf(h);
    const unchanged = unchangedBy(h);

    const other = await run(h, rotateArgv(h, ['--execute', '--retiring-store', `solver=${stores.solver}`]));

    expect(other.code).toBe('invalid_invocation');
    expect(String(other.message)).toContain(receiptPathOf(h));
    unchanged();

    const result = await run(h, rotateArgv(h, ['--execute', '--retiring-store', `solver=${retiring.solver}`]));

    expect(result.kind).toBe('ceremony_rotate_complete');
    expect(result.resumed).toBe(true);
    expect(h.submitted).toHaveLength(3);
  });

  it.each([
    ['a family --role-sets does not name', (store: string) => [`solver=${store}`, '--retiring-store', `requester=${store}`], 'for a family of --role-sets'],
    ['no family', (store: string) => [store], 'for a family of --role-sets'],
    ['a family twice', (store: string) => [`solver=${store}`, '--retiring-store', `solver=${store}`], 'more than once'],
    ['a relative path', (_store: string) => ['solver=identity/solver.enc.json'], 'must be an absolute path'],
  ])('refuses a --retiring-store naming %s', async (_case, values, expected) => {
    const h = await stoppedAfterRepoint();
    const { retiring } = storesOf(h);
    rmSync(receiptPathOf(h));
    const unchanged = unchangedBy(h);

    const refusal = await run(h, rotateArgv(h, ['--execute', '--retiring-store', ...values(retiring.solver!)]));

    expect(refusal.code).toBe('invalid_invocation');
    expect(String(refusal.message)).toContain(expected);
    unchanged();
  });

  it('refuses, before it opens any store, a family of --role-sets that --retiring-store leaves unnamed', async () => {
    const h = await stoppedAfterRepoint();
    const { retiring } = storesOf(h);
    rmSync(receiptPathOf(h));
    const unchanged = unchangedBy(h);
    const opened = storesOpened.length;

    const refusal = await run(h, [
      'rotate', '--dir', h.dir, '--role-sets', 'requester,solver', '--execute', '--retiring-store', `solver=${retiring.solver}`,
    ]);

    expect(refusal.code).toBe('invalid_invocation');
    expect(String(refusal.message)).toContain('--retiring-store names no store for requester');
    expect(storesOpened).toHaveLength(opened);
    unchanged();
  });

  it('refuses, before any anchor, a --retiring-store naming a store of another family', async () => {
    const h = await stoppedAfterRepoint();
    rmSync(receiptPathOf(h));
    const requesterStore = config(h).identityStores.requester!;
    const unchanged = unchangedBy(h);

    const refusal = await run(h, rotateArgv(h, ['--execute', '--retiring-store', `solver=${requesterStore}`]));

    expect(refusal.code).toBe('invalid_invocation');
    expect(String(refusal.message)).toContain(`the solver store at ${requesterStore} could not be opened`);
    expect(String(refusal.message)).toContain('owned role set does not match');
    unchanged();
  });

  it.each([
    ['through ..', (h: Harness, store: string) => `${h.dir}/identity/../identity/${basename(store)}`],
    ['through a symbolic link', (h: Harness, store: string) => {
      const link = join(h.home, 'solver-alias.enc.json');
      symlinkSync(store, link);
      return link;
    }],
  ])('refuses a --retiring-store path that reaches the store identityStores names %s, whose keys the lost rotation just bound', async (_case, alias) => {
    const h = await stoppedAfterRepoint();
    const { stores } = storesOf(h);
    rmSync(receiptPathOf(h));
    const named = alias(h, stores.solver!);
    expect(named).not.toBe(stores.solver);
    const unchanged = unchangedBy(h);

    const refusal = await run(h, rotateArgv(h, ['--execute', '--retiring-store', `solver=${named}`]));

    expect(refusal.code).toBe('invalid_invocation');
    expect(refusal.details).toMatchObject({ state: 'retiring-store-mismatch', sideEffects: false });
    expect(String(refusal.message)).toContain('no earlier than');
    unchanged();
  });

  it('finishes from --retiring-store in the same second the lost rotation started, though a new rotation would refuse its store', async () => {
    const { h, retiring, stores, plain, result } = await inOneSecond(() => provisioned({ interruptWait: 'revocation' }), async (h) => {
      await expect(run(h, rotateArgv(h, ['--execute']))).rejects.toThrow(/killed during the revocation finality wait/u);
      const { retiring, stores } = storesOf(h);
      rmSync(receiptPathOf(h));
      // In this second a new rotation would mint at the store the lost rotation bound.
      const plain = await run(h, rotateArgv(h));
      const result = await run(h, rotateArgv(h, ['--execute', '--retiring-store', `solver=${retiring.solver}`]));
      return { h, retiring, stores, plain, result };
    });

    expect(plain.details).toMatchObject({ state: 'new-store-exists', path: stores.solver });
    // Finishing the lost rotation takes that store as its new one and mints none, so it never meets
    // the refusal.
    expect(result.kind).toBe('ceremony_rotate_complete');
    expect(keyIdsOf(result, 'retired')).toEqual(await keyIdsIn(retiring.solver!, SOLVER_ROLES));
    expect(result.storesCreated).toEqual([]);
    expect(config(h).identityStores.solver).toBe(stores.solver);
    const revokedAt = h.submitted[h.submitted.length - 1]!.anchorTime;
    await expect(bootAt(h, retiring.solver!, revokedAt)).rejects.toThrow(/binding is revoked at boot/u);
    await expect(bootAt(h, stores.solver!, revokedAt)).resolves.toBeDefined();
  });
});

describe('ceremony rotate, one run at a time on an operator directory (#5366)', () => {
  const rotateArgv = (h: Harness, extra: readonly string[] = []) => [
    'rotate', '--dir', h.dir, '--role-sets', 'solver', ...extra,
  ];
  const lockPathOf = (h: Harness) => join(h.dir, 'ceremony', 'rotate.lock');
  type Family = Parameters<typeof orderedRolesForSet>[0];
  const nextSecond = () => new Promise((resolve) => { setTimeout(resolve, 1_000 - (Date.now() % 1_000)); });

  afterEach(() => {
    afterWrite.path = undefined;
    afterWrite.then = undefined;
    afterPlanRevocation.pause = undefined;
  });

  /** A run's last envelope, or what it threw. */
  async function outcome(pending: Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    try {
      return await pending;
    } catch (error) {
      return { thrown: String(error) };
    }
  }

  async function keyIdsIn(storePath: string, family: Family): Promise<string[]> {
    const signers = await openRoleSigners({
      storePath, password: PASSWORD, ownedRoles: orderedRolesForSet(family), create: false,
    });
    return [...signers.values()].map(({ keyId }) => keyId).sort();
  }

  function revocationTargets(h: Harness): string[] {
    const file = JSON.parse(readFileSync(h.catalogPath, 'utf-8')) as { revocations: { envelope: string }[] };
    return file.revocations.map(({ envelope }) =>
      validateRevocation(new Uint8Array(Buffer.from(envelope, 'base64'))).value!.target);
  }

  /**
   * Exactly one rotation of the solver family happened since the catalog held `before`, retiring the
   * keys of `retiredStore`: one set of new keys bound, held by the store the config names; each
   * retiring binding revoked once and nothing else revoked; and no key the catalog binds, unrevoked,
   * that no store the config names holds.
   */
  async function expectOneRotation(
    h: Harness,
    before: ReturnType<typeof catalogBindings>,
    revokedBefore: readonly string[],
    retiredStore: string,
  ): Promise<void> {
    const retiringKeys = await keyIdsIn(retiredStore, 'solver');
    const retiringDigests = before.filter(({ binding }) => retiringKeys.includes(binding.key.didKey)).map(({ digest }) => digest);
    const added = catalogBindings(h).filter(({ digest }) => !before.some((earlier) => earlier.digest === digest));
    expect(added.map(({ binding }) => binding.key.didKey).sort())
      .toEqual(await keyIdsIn(config(h).identityStores.solver!, 'solver'));
    const targets = revocationTargets(h);
    expect(targets).toHaveLength(revokedBefore.length + retiringDigests.length);
    for (const digest of retiringDigests) expect(targets.filter((target) => target === digest)).toHaveLength(1);
    const held = new Set<string>();
    for (const [family, storePath] of Object.entries(config(h).identityStores)) {
      // eslint-disable-next-line no-await-in-loop -- bounded (≤4 families).
      for (const keyId of await keyIdsIn(storePath, family as Family)) held.add(keyId);
    }
    const revoked = new Set(targets);
    expect(catalogBindings(h)
      .filter(({ digest, binding }) => !revoked.has(digest) && !held.has(binding.key.didKey))
      .map(({ binding }) => binding.key.didKey)).toEqual([]);
  }

  it('lets exactly one of two rotate --execute runs started together on one operator directory rotate, and refuses the other, naming the run that holds it', async () => {
    const h = await provisioned();
    const retiredStore = config(h).identityStores.solver!;
    const before = catalogBindings(h);
    const revokedBefore = revocationTargets(h);
    const submissions = h.submitted.length;

    const results = await Promise.all([
      outcome(run(h, rotateArgv(h, ['--execute']))),
      outcome(run(h, rotateArgv(h, ['--execute']))),
    ]);

    expect(results.filter(({ kind }) => kind === 'ceremony_rotate_complete')).toHaveLength(1);
    const refusals = results.filter(({ kind }) => kind !== 'ceremony_rotate_complete');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      code: 'invalid_invocation',
      details: {
        state: 'rotation-in-progress',
        sideEffects: false,
        lock: lockPathOf(h),
        holder: { pid: process.pid, host: hostname() },
      },
    });
    expect(String(refusals[0]!.message)).toContain(`process ${process.pid} on ${hostname()}`);
    // One rebind anchor and one revocation anchor, both from the run that held the directory.
    expect(h.submitted).toHaveLength(submissions + 2);
    await expectOneRotation(h, before, revokedBefore, retiredStore);
    expect(existsSync(lockPathOf(h))).toBe(false);
    expect(createCeremonyCommand(h.deps).helpText).toContain('rotation-in-progress');
  });

  it('refuses a run started in a later second, while another is between its checks and its receipt, so no second set of keys is bound', async () => {
    const h = await provisioned();
    const retiredStore = config(h).identityStores.solver!;
    const before = catalogBindings(h);
    const revokedBefore = revocationTargets(h);
    const submissions = h.submitted.length;
    // The first run stops once it has planned the revocation, before it records its rotation.
    let resume!: () => void;
    const planned = new Promise<void>((resolve) => {
      afterPlanRevocation.pause = () => {
        resolve();
        return new Promise<void>((go) => { resume = go; });
      };
    });
    const first = outcome(run(h, rotateArgv(h, ['--execute'])));
    await planned;
    // The second starts in a later second, so it would name a new store of its own.
    await nextSecond();

    const second = await outcome(run(h, rotateArgv(h, ['--execute'])));
    resume();
    const firstResult = await first;

    expect(second).toMatchObject({ code: 'invalid_invocation', details: { state: 'rotation-in-progress', sideEffects: false } });
    expect(firstResult.kind).toBe('ceremony_rotate_complete');
    expect(h.submitted).toHaveLength(submissions + 2);
    expect(readdirSync(join(h.dir, 'identity')).filter((name) => name.startsWith('solver.rotated-'))).toHaveLength(1);
    await expectOneRotation(h, before, revokedBefore, retiredStore);
  });

  it('refuses while the process a left-behind lock names is running, and takes the lock over once it is gone', async () => {
    const h = await provisioned();
    // What a run killed mid-rotation leaves behind: its lock, naming its process.
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      writeFileSync(lockPathOf(h), `${JSON.stringify({
        pid: holder.pid, host: hostname(), startedAt: new Date().toISOString(), token: 'left-behind',
      })}\n`);
      const submissions = h.submitted.length;
      const configBytes = readFileSync(h.configPath);

      const refusal = await run(h, rotateArgv(h, ['--execute']));

      expect(refusal).toMatchObject({
        code: 'invalid_invocation',
        details: { state: 'rotation-in-progress', sideEffects: false, holder: { pid: holder.pid } },
      });
      expect(String(refusal.hint)).toContain(`remove ${lockPathOf(h)}`);
      expect(h.submitted).toHaveLength(submissions);
      expect(readFileSync(h.configPath)).toEqual(configBytes);
      expect(existsSync(join(h.dir, 'ceremony', 'rotation.json'))).toBe(false);
      expect(existsSync(lockPathOf(h))).toBe(true);
    } finally {
      holder.kill('SIGKILL');
      await once(holder, 'exit');
    }

    const result = await run(h, rotateArgv(h, ['--execute']));

    expect(result.kind).toBe('ceremony_rotate_complete');
    expect(readdirSync(join(h.dir, 'ceremony')).sort()).toEqual(['receipt.json', 'rotation.json']);
  });

  it('refuses a lock written on another host, which it cannot check, and says how to clear it; the plan takes no lock', async () => {
    const h = await provisioned();
    const elsewhere = `not-${hostname()}`;
    // A process number that exists nowhere on this host, which says nothing about the other one.
    const { pid } = spawnSync(process.execPath, ['-e', '']);
    writeFileSync(lockPathOf(h), `${JSON.stringify({
      pid, host: elsewhere, startedAt: new Date().toISOString(), token: 'elsewhere',
    })}\n`);

    const refusal = await run(h, rotateArgv(h, ['--execute']));

    expect(refusal).toMatchObject({ details: { state: 'rotation-in-progress', sideEffects: false, holder: { host: elsewhere } } });
    expect(String(refusal.message)).toContain(`on ${elsewhere}`);
    expect(String(refusal.hint)).toContain(`remove ${lockPathOf(h)}`);
    expect((await run(h, rotateArgv(h))).kind).toBe('ceremony_rotate_plan');

    rmSync(lockPathOf(h));
    expect((await run(h, rotateArgv(h, ['--execute']))).kind).toBe('ceremony_rotate_complete');
  });

  it('releases the lock however a run ends: before a refusal exits, when it is interrupted, and when it completes', async () => {
    const h = await provisioned({ interruptWait: 'revocation' });
    h.useAccount(strangerAccount);
    const lockAtExit: boolean[] = [];

    const refusal = await run(h, rotateArgv(h, ['--execute']), () => { lockAtExit.push(existsSync(lockPathOf(h))); });

    expect(String(refusal.message)).toContain('cannot revoke the retiring bindings');
    // In production a refusal exits the process right there, so no `finally` would release it.
    expect(lockAtExit).toEqual([false]);
    h.useAccount(agentAccount);
    await expect(run(h, rotateArgv(h, ['--execute']))).rejects.toThrow(/killed during the revocation finality wait/u);
    expect(existsSync(lockPathOf(h))).toBe(false);
    expect((await run(h, rotateArgv(h, ['--execute']))).kind).toBe('ceremony_rotate_complete');
    expect(readdirSync(join(h.dir, 'ceremony')).sort()).toEqual(['receipt.json', 'rotation.json']);
  });

  /**
   * An exit that records `<dir>/ceremony` when a refusal calls it. In production the exit is
   * `process.exit`, which runs no `finally`, so what is there at that moment is what stays.
   */
  const recordingExit = (h: Harness, seen: string[][]) => () => {
    seen.push(readdirSync(join(h.dir, 'ceremony')).sort());
  };
  const writeLock = (h: Harness, holder: { readonly pid: number; readonly token: string }) => {
    writeFileSync(lockPathOf(h), `${JSON.stringify({ host: hostname(), startedAt: new Date().toISOString(), ...holder })}\n`);
  };

  it('leaves no file of its own in <dir>/ceremony when it refuses, though the process exits right there', async () => {
    const h = await provisioned();
    writeLock(h, { pid: process.pid, token: 'live' });
    const before = readdirSync(join(h.dir, 'ceremony')).sort();
    const atExit: string[][] = [];

    const refusal = await run(h, rotateArgv(h, ['--execute']), recordingExit(h, atExit));

    expect(refusal.details).toMatchObject({ state: 'rotation-in-progress', holder: { token: 'live' } });
    expect(atExit).toEqual([before]);
  });

  it('removes the takeover file it created when another run takes a stale lock first, before the refusal exits', async () => {
    const h = await provisioned();
    const { pid: gone } = spawnSync(process.execPath, ['-e', '']);
    writeLock(h, { pid: gone, token: 'killed' });
    const before = readdirSync(join(h.dir, 'ceremony')).sort();
    // Once this run has created the takeover file, another run's lock replaces the stale one.
    afterWrite.path = `${lockPathOf(h)}.takeover`;
    afterWrite.then = () => { writeLock(h, { pid: process.pid, token: 'faster' }); };
    const atExit: string[][] = [];

    const refusal = await run(h, rotateArgv(h, ['--execute']), recordingExit(h, atExit));

    expect(refusal.details).toMatchObject({ state: 'rotation-in-progress', holder: { token: 'faster' } });
    expect(atExit).toEqual([before]);
    // With no takeover file left, a lock left later by a killed run is still taken over by itself.
    writeLock(h, { pid: gone, token: 'killed-again' });
    expect((await run(h, rotateArgv(h, ['--execute']))).kind).toBe('ceremony_rotate_complete');
  });

  it('leaves alone a takeover file it did not create, and names it, when it refuses', async () => {
    const h = await provisioned();
    const { pid: gone } = spawnSync(process.execPath, ['-e', '']);
    writeLock(h, { pid: gone, token: 'killed' });
    writeFileSync(`${lockPathOf(h)}.takeover`, '{}\n');
    const before = readdirSync(join(h.dir, 'ceremony')).sort();
    const atExit: string[][] = [];

    const refusal = await run(h, rotateArgv(h, ['--execute']), recordingExit(h, atExit));

    expect(refusal.details).toMatchObject({ state: 'rotation-in-progress', holder: { token: 'killed' } });
    expect(String(refusal.hint)).toContain(`${lockPathOf(h)}.takeover`);
    expect(atExit).toEqual([before]);
  });

  it('takes no keys from a store that appears at its new store\'s path after its checks ran, and undoes what it wrote', async () => {
    const h = await provisioned();
    const retiringStore = config(h).identityStores.solver!;
    const sessions = h.calls.filter((call) => call === 'openAnchorSession').length;
    const submissions = h.submitted.length;
    const catalog = readFileSync(h.catalogPath);
    const configBytes = readFileSync(h.configPath);
    const stores = readdirSync(join(h.dir, 'identity')).sort();
    // Once the run has checked its new stores' paths and recorded its rotation, a store appears at
    // the solver one. The requester store comes first, so the run has minted it by then.
    let appeared: string | undefined;
    afterWrite.path = join(h.dir, 'ceremony', 'rotation.json');
    afterWrite.then = (written) => {
      appeared = (JSON.parse(readFileSync(written, 'utf-8')) as { stores: Record<string, string> }).stores.solver!;
      copyFileSync(retiringStore, appeared);
    };

    const refusal = await run(h, ['rotate', '--dir', h.dir, '--role-sets', 'requester,solver', '--execute']);

    expect(appeared).toBeDefined();
    expect(refusal).toMatchObject({
      code: 'invalid_invocation',
      details: { state: 'new-store-exists', sideEffects: false, family: 'solver', path: appeared },
    });
    expect(h.calls.filter((call) => call === 'openAnchorSession')).toHaveLength(sessions);
    expect(h.submitted).toHaveLength(submissions);
    expect(readFileSync(h.catalogPath)).toEqual(catalog);
    expect(readFileSync(h.configPath)).toEqual(configBytes);
    // No rotation recorded, the requester store it minted removed, and the store that appeared left alone.
    expect(existsSync(join(h.dir, 'ceremony', 'rotation.json'))).toBe(false);
    expect(readdirSync(join(h.dir, 'identity')).sort()).toEqual([...stores, basename(appeared!)].sort());
    expect(readFileSync(appeared!)).toEqual(readFileSync(retiringStore));
  });
});
