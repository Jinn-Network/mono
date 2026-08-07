/**
 * `jinn ceremony` command surface (spec/2026-08-07-native-identity-ceremony.md §4).
 *
 * Only the CHAIN-touching deps are injected. Custody minting, ceremony signing, binding sealing and
 * catalog authoring run for real against a tmpdir, so these tests exercise the same
 * `@jinn-network/trust-authoring` code an operator's ceremony runs rather than a mock of it — which
 * is the point: the gap this whole spec closes was created by a fixture that shadow-implemented the
 * production formats convincingly enough that nothing noticed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTrustPolicy } from '@jinn-network/trust-core';
import { beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli/index.js';
import {
  ceremonyAnchorDigest,
  createCeremonyCommand,
  resolveCeremonyPassword,
  type CeremonyCommandDeps,
} from '../../src/cli/commands/ceremony.js';
import type { CommandContext } from '../../src/cli/command.js';

const AGENT_EOA = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const SAFE = '0x8464135c8F25Da09e49BC8782676a84730C318bC' as const;
const ANCHOR_TIME = '2026-08-07T12:00:00.000Z';
const PASSWORD = 'ceremony-cli-test-password';

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

/** Every JSON line the command emitted, newest last. */
function envelopes(writes: string[]): Record<string, unknown>[] {
  return writes.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

function lastEnvelope(writes: string[]): Record<string, unknown> {
  const all = envelopes(writes);
  return all[all.length - 1]!;
}

interface Harness {
  readonly home: string;
  readonly dir: string;
  readonly configPath: string;
  readonly authorityStore: string;
  readonly deps: CeremonyCommandDeps;
  readonly calls: string[];
}

function harness(options: { readonly safeOwns?: boolean; readonly custodyThrows?: string } = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), 'ceremony-cli-'));
  const dir = join(home, '.jinn-client');
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'config.json');
  const calls: string[] = [];

  const deps: CeremonyCommandDeps = {
    async readChainCustody() {
      calls.push('readChainCustody');
      if (options.custodyThrows !== undefined) throw new Error(options.custodyThrows);
      return { serviceIndex: 72, agentEoa: AGENT_EOA, safeAddress: SAFE };
    },
    async verifySafeOwnership() {
      calls.push('verifySafeOwnership');
      return options.safeOwns ?? true;
    },
    async openAnchorSession() {
      calls.push('openAnchorSession');
      return {
        async signMessage() { return `0x${'55'.repeat(65)}` as `0x${string}`; },
        async submit(digest) {
          calls.push(`submit:${digest}`);
          return {
            profile: 'https://spec.jinn.network/trust/anchor-locators/base-sepolia-calldata-v1',
            chainId: 84532,
            transactionHash: `0x${'ab'.repeat(32)}`,
            contractAddress: AGENT_EOA,
            inputByteOffset: 0,
            anchorTime: ANCHOR_TIME,
          };
        },
        async waitForFinalized(input) {
          calls.push('waitForFinalized');
          return {
            digest: input.digest,
            anchorTime: ANCHOR_TIME,
            chainId: 84532,
            transactionHash: `0x${'ab'.repeat(32)}`,
            blockHash: `0x${'ef'.repeat(32)}`,
            blockNumber: 1n,
            finalized: true,
          };
        },
      };
    },
  };

  return { home, dir, configPath, authorityStore: join(home, '.jinn-ceremony', 'authority.enc.json'), deps, calls };
}

function context(input: {
  readonly argv: string[];
  readonly home: string;
  readonly password?: string;
}) {
  const io = captureIo();
  return {
    io,
    ctx: {
      argv: input.argv,
      stdoutIsTty: false,
      writer: io.writer,
      exit: io.exit,
      env: {
        HOME: input.home,
        ...(input.password === undefined ? {} : { JINN_PASSWORD: input.password }),
      } as NodeJS.ProcessEnv,
    } satisfies CommandContext,
  };
}

function initArgv(h: Harness, extra: string[] = []): string[] {
  return [
    'init',
    '--dir', h.dir,
    '--role-sets', 'requester,admission,solver,evaluator',
    '--authority-store', h.authorityStore,
    ...extra,
  ];
}

describe('ceremony CLI registration', () => {
  it('is a registered verb whose help documents init, join, and show', async () => {
    const io = captureIo();
    await runCli(['ceremony', '--help'], { writer: io.writer, exit: io.exit, stdoutIsTty: false });
    const help = io.writes.join('');
    expect(help).toContain('jinn ceremony init');
    expect(help).toContain('jinn ceremony join');
    expect(help).toContain('jinn ceremony show');
    expect(io.exits).toEqual([]);
  });

  it('refuses an unknown subcommand', async () => {
    const h = harness();
    const { ctx, io } = context({ argv: ['rotate'], home: h.home });
    await createCeremonyCommand(h.deps).run(ctx);
    expect(lastEnvelope(io.writes).code).toBe('invalid_invocation');
    expect(String(lastEnvelope(io.writes).message)).toContain('`init`, `join`, or `show`');
  });
});

describe('ceremony init — read-only plan', () => {
  it('reports a full plan and takes no side effects without --execute', async () => {
    const h = harness();
    const { ctx, io } = context({ argv: initArgv(h), home: h.home, password: PASSWORD });
    await createCeremonyCommand(h.deps).run(ctx);

    const result = lastEnvelope(io.writes);
    expect(result.kind).toBe('ceremony_init_plan');
    expect(result.executeAuthorized).toBe(false);
    expect(result.sideEffects).toBe(false);
    expect(result.agentEoa).toBe(AGENT_EOA);
    expect(result.safeAddress).toBe(SAFE);
    expect(result.safeOwnershipVerified).toBe(true);
    expect(result.agentIri).toMatch(/^urn:uuid:/u);
    expect(result.admissionAgent).toMatch(/^urn:uuid:/u);
    expect(result.admissionAgent).not.toBe(result.agentIri);
    expect(result.restartRequired).toBe(true);

    // Nothing minted, nothing sent, nothing written.
    expect(h.calls).not.toContain('openAnchorSession');
    expect(existsSync(join(h.dir, 'identity'))).toBe(false);
    expect(existsSync(h.authorityStore)).toBe(false);
    expect(existsSync(h.configPath)).toBe(false);
    expect(existsSync(join(h.dir, 'trust.json'))).toBe(false);
  });

  it('names the five config keys it would write and the deploy-config it cannot supply', async () => {
    const h = harness();
    const { ctx, io } = context({ argv: initArgv(h), home: h.home, password: PASSWORD });
    await createCeremonyCommand(h.deps).run(ctx);

    const plan = lastEnvelope(io.writes).configWriteBack as { written: string[]; outstanding: string[] };
    expect(plan.written.sort()).toEqual([
      'admissionAgent', 'agentIri', 'identityStores', 'trustPolicyGenesisDigest', 'trustRootsPath',
    ]);
    // The ceremony cannot know an IPFS endpoint, this host's public URL, or who the peers are.
    expect(plan.outstanding.sort()).toEqual(['ipfs.apiUrl', 'publicBaseUrl', 'recordSources']);
  });

  it('checks Safe ownership BEFORE anything is minted, and refuses when it does not hold', async () => {
    const h = harness({ safeOwns: false });
    const { ctx, io } = context({ argv: initArgv(h, ['--execute']), home: h.home, password: PASSWORD });
    await createCeremonyCommand(h.deps).run(ctx);

    const result = lastEnvelope(io.writes);
    expect(result.code).toBe('invalid_invocation');
    expect(String(result.message)).toContain('does not report');
    expect(h.calls).toEqual(['readChainCustody', 'verifySafeOwnership']);
    expect(existsSync(join(h.dir, 'identity'))).toBe(false);
  });

  it('refuses when the operator has no earning state to bind to', async () => {
    const h = harness({ custodyThrows: 'no earning state at /x/earning' });
    const { ctx, io } = context({ argv: initArgv(h), home: h.home, password: PASSWORD });
    await createCeremonyCommand(h.deps).run(ctx);
    expect(lastEnvelope(io.writes).code).toBe('invalid_invocation');
    expect(String(lastEnvelope(io.writes).hint)).toContain('jinn bootstrap');
  });

  /**
   * §4.4: the fleet runtime opens requester custody on EVERY boot, including a solver-only
   * operator's. A ceremony that honored `--role-sets solver` literally would mint a catalog whose
   * own owner's daemon refuses to start.
   */
  it('refuses --role-sets without the mandatory requester family', async () => {
    const h = harness();
    const { ctx, io } = context({
      argv: ['init', '--dir', h.dir, '--role-sets', 'solver', '--authority-store', h.authorityStore],
      home: h.home,
      password: PASSWORD,
    });
    await createCeremonyCommand(h.deps).run(ctx);
    expect(String(lastEnvelope(io.writes).message)).toContain('must include `requester`');
  });

  it('refuses a duplicated --role-sets family rather than deduping it', async () => {
    const h = harness();
    const { ctx, io } = context({
      argv: ['init', '--dir', h.dir, '--role-sets', 'requester,requester', '--authority-store', h.authorityStore],
      home: h.home,
      password: PASSWORD,
    });
    await createCeremonyCommand(h.deps).run(ctx);
    expect(String(lastEnvelope(io.writes).message)).toContain('more than once');
  });

  it('refuses an unknown --role-sets family', async () => {
    const h = harness();
    const { ctx, io } = context({
      argv: ['init', '--dir', h.dir, '--role-sets', 'requester,auditor', '--authority-store', h.authorityStore],
      home: h.home,
      password: PASSWORD,
    });
    await createCeremonyCommand(h.deps).run(ctx);
    expect(String(lastEnvelope(io.writes).message)).toContain('unknown family "auditor"');
  });

  /** §5: the authority key must survive any operator's rotation, so it cannot BE operator custody. */
  it('refuses an --authority-store inside the operator\'s own identity directory', async () => {
    const h = harness();
    const { ctx, io } = context({
      argv: [
        'init', '--dir', h.dir, '--role-sets', 'requester',
        '--authority-store', join(h.dir, 'identity', 'authority.enc.json'),
      ],
      home: h.home,
      password: PASSWORD,
    });
    await createCeremonyCommand(h.deps).run(ctx);
    expect(String(lastEnvelope(io.writes).message)).toContain('must not live under');
  });

  it('requires --authority-store at all', async () => {
    const h = harness();
    const { ctx, io } = context({
      argv: ['init', '--dir', h.dir, '--role-sets', 'requester'],
      home: h.home,
      password: PASSWORD,
    });
    await createCeremonyCommand(h.deps).run(ctx);
    expect(String(lastEnvelope(io.writes).message)).toContain('--authority-store');
  });
});

describe('ceremony password identity guard', () => {
  /**
   * The daemon's keystore-password fallback path is HARD-CODED to `~/.jinn-client/keystore-password`
   * and does not follow `--dir`, so operator B at `~/.jinn-client-op-b` has no fallback at all. A
   * ceremony that picked its own password there would mint custody the daemon can never decrypt —
   * a failure that surfaces only at the next boot, after the anchor gas is spent.
   */
  it('refuses a non-default operator dir with no JINN_PASSWORD', () => {
    const home = mkdtempSync(join(tmpdir(), 'ceremony-pw-'));
    const resolution = resolveCeremonyPassword({
      dir: join(home, '.jinn-client-op-b'),
      env: { HOME: home } as NodeJS.ProcessEnv,
    });
    expect('refusal' in resolution).toBe(true);
    expect((resolution as { refusal: string }).refusal).toContain('JINN_PASSWORD is required');
    expect((resolution as { hint: string }).hint).toContain('does not follow --dir');
  });

  it('warns that a non-default dir needs JINN_PASSWORD at every daemon start too', () => {
    const home = mkdtempSync(join(tmpdir(), 'ceremony-pw-'));
    const resolution = resolveCeremonyPassword({
      dir: join(home, '.jinn-client-op-b'),
      env: { HOME: home, JINN_PASSWORD: PASSWORD } as NodeJS.ProcessEnv,
    });
    expect(resolution).toMatchObject({ password: PASSWORD, source: 'env' });
    expect((resolution as { warnings: string[] }).warnings.join(' ')).toContain('every daemon start');
  });

  it('uses the keystore-password file for the default dir — the value the daemon itself resolves', () => {
    const home = mkdtempSync(join(tmpdir(), 'ceremony-pw-'));
    mkdirSync(join(home, '.jinn-client'), { recursive: true });
    writeFileSync(join(home, '.jinn-client', 'keystore-password'), `${PASSWORD}\n`);
    const resolution = resolveCeremonyPassword({
      dir: join(home, '.jinn-client'),
      env: { HOME: home } as NodeJS.ProcessEnv,
    });
    expect(resolution).toMatchObject({ password: PASSWORD, source: 'keystore-file', warnings: [] });
  });

  it('refuses the default dir when neither the env var nor the password file exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'ceremony-pw-'));
    mkdirSync(join(home, '.jinn-client'), { recursive: true });
    const resolution = resolveCeremonyPassword({
      dir: join(home, '.jinn-client'),
      env: { HOME: home } as NodeJS.ProcessEnv,
    });
    expect('refusal' in resolution).toBe(true);
    expect((resolution as { hint: string }).hint).toContain('auto-generates');
  });

  /** The daemon prefers the env var, so this only bites the first start that forgets to set it. */
  it('warns when JINN_PASSWORD disagrees with the on-disk keystore password', () => {
    const home = mkdtempSync(join(tmpdir(), 'ceremony-pw-'));
    mkdirSync(join(home, '.jinn-client'), { recursive: true });
    writeFileSync(join(home, '.jinn-client', 'keystore-password'), 'a-different-password\n');
    const resolution = resolveCeremonyPassword({
      dir: join(home, '.jinn-client'),
      env: { HOME: home, JINN_PASSWORD: PASSWORD } as NodeJS.ProcessEnv,
    });
    expect((resolution as { warnings: string[] }).warnings.join(' ')).toContain('differs from the password stored');
  });

  it('refuses to execute when no password is resolvable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ceremony-cli-'));
    const dir = join(home, '.jinn-client-op-b');
    mkdirSync(dir, { recursive: true });
    const h = harness();
    const { ctx, io } = context({
      argv: [
        'init', '--dir', dir, '--role-sets', 'requester',
        '--authority-store', join(home, 'authority.enc.json'), '--execute',
      ],
      home,
    });
    await createCeremonyCommand(h.deps).run(ctx);
    const result = lastEnvelope(io.writes);
    expect(result.code).toBe('invalid_invocation');
    expect((result.details as { state: string }).state).toBe('password-identity-unresolvable');
    expect(existsSync(join(dir, 'identity'))).toBe(false);
  });
});

describe('ceremony init --execute', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  async function execute(extra: string[] = []): Promise<ReturnType<typeof captureIo>> {
    const { ctx, io } = context({ argv: initArgv(h, ['--execute', ...extra]), home: h.home, password: PASSWORD });
    await createCeremonyCommand(h.deps).run(ctx);
    return io;
  }

  it('mints custody, anchors, waits for finality, and authors the catalog in the §6 order', async () => {
    const io = await execute();
    const result = lastEnvelope(io.writes);
    expect(result.kind).toBe('ceremony_init_complete');
    expect(result.sideEffects).toBe(true);

    // §6 law 1: the anchor is submitted before any binding exists, and law 4: finality is awaited
    // before the catalog is authored.
    const submitIndex = h.calls.findIndex((call) => call.startsWith('submit:'));
    expect(submitIndex).toBeGreaterThan(-1);
    expect(h.calls.indexOf('waitForFinalized')).toBeGreaterThan(submitIndex);

    // §6 law 2: validFrom is the anchor's block time, VERBATIM.
    expect(result.validFrom).toBe(ANCHOR_TIME);

    expect(existsSync(join(h.dir, 'identity', 'requester.enc.json'))).toBe(true);
    expect(existsSync(join(h.dir, 'identity', 'admission.enc.json'))).toBe(true);
    expect(existsSync(join(h.dir, 'identity', 'solver.enc.json'))).toBe(true);
    expect(existsSync(join(h.dir, 'identity', 'evaluator.enc.json'))).toBe(true);
    expect(existsSync(h.authorityStore)).toBe(true);
    expect(existsSync(join(h.dir, 'trust.json'))).toBe(true);
  });

  it('authors a genesis policy carrying the complete §6 law 3 purpose set', async () => {
    await execute();
    const catalog = JSON.parse(readFileSync(join(h.dir, 'trust.json'), 'utf-8')) as {
      policies: { envelope: string }[];
    };
    const report = validateTrustPolicy(new Uint8Array(Buffer.from(catalog.policies[0]!.envelope, 'base64')));
    const purposes = Object.keys(report.value!.purposes);
    // The two that a catalog silently omits and then fails the evaluator boot on.
    expect(purposes).toContain('evaluator-eligibility');
    expect(purposes).toContain('admission-agent');
    expect(purposes).toContain('native:admission');
    // Every bound role.
    expect(purposes).toContain('native:requester-submission');
    expect(purposes).toContain('native:solver-settlement');
    expect(purposes).toContain('native:evaluator-verdict');
  });

  /**
   * §5: the policy is signed by the DEDICATED authority keypair, never by an operator role key.
   * The fixture's `policySigner = roleKeys[0]` expedient is exactly what production must not do.
   */
  it('signs the genesis with the dedicated authority key, not an operator role key', async () => {
    const io = await execute();
    const catalog = JSON.parse(readFileSync(join(h.dir, 'trust.json'), 'utf-8')) as {
      policies: { envelope: string }[];
    };
    const signerKeys = validateTrustPolicy(
      new Uint8Array(Buffer.from(catalog.policies[0]!.envelope, 'base64')),
    ).value!.signerSet.keys;
    const roleKeyIds = (lastEnvelope(io.writes).bindings as { keyId: string }[]).map(({ keyId }) => keyId);
    expect(signerKeys).toHaveLength(1);
    expect(roleKeyIds).not.toContain(signerKeys[0]);
  });

  it('writes exactly the five identity keys back, preserving every other config key', async () => {
    writeFileSync(h.configPath, JSON.stringify({
      rpcUrl: 'https://sepolia.base.org',
      claudeModel: 'claude-haiku-4-5-20251001',
      tasks: [{ id: 'keep-me' }],
      joinedSolverNets: { 'bafy...': { name: 'demo' } },
    }, null, 2));

    const io = await execute();
    const config = JSON.parse(readFileSync(h.configPath, 'utf-8')) as Record<string, unknown>;

    expect(config.agentIri).toBe(lastEnvelope(io.writes).agentIri);
    expect(config.admissionAgent).toBe(lastEnvelope(io.writes).admissionAgent);
    expect(config.trustRootsPath).toBe(join(h.dir, 'trust.json'));
    expect(config.trustPolicyGenesisDigest).toBe(lastEnvelope(io.writes).policyGenesisDigest);
    expect(config.identityStores).toEqual({
      requester: join(h.dir, 'identity', 'requester.enc.json'),
      admission: join(h.dir, 'identity', 'admission.enc.json'),
      solver: join(h.dir, 'identity', 'solver.enc.json'),
      evaluator: join(h.dir, 'identity', 'evaluator.enc.json'),
    });

    // Untouched.
    expect(config.rpcUrl).toBe('https://sepolia.base.org');
    expect(config.tasks).toEqual([{ id: 'keep-me' }]);
    expect(config.joinedSolverNets).toEqual({ 'bafy...': { name: 'demo' } });
    // The flip stays the deploy PR's one switch.
    expect(config.compositionMode).toBeUndefined();
  });

  it('states that the catalog must be distributed and every daemon restarted', async () => {
    const io = await execute();
    const result = lastEnvelope(io.writes);
    expect(result.restartRequired).toBe(true);
    expect((result.nextSteps as string[]).join(' ')).toContain('restart');
  });

  it('refuses a second genesis at the same catalog path', async () => {
    await execute();
    const io = await execute();
    const result = lastEnvelope(io.writes);
    expect(result.code).toBe('invalid_invocation');
    expect(String(result.message)).toContain('genesis never overwrites');
    expect(String(result.hint)).toContain('jinn ceremony join');
  });

  /** Re-minting IRIs on a re-run would author bindings for an identity no existing catalog accepts. */
  it('reuses the agent IRIs a previous run recorded rather than minting new ones', async () => {
    const first = await execute();
    const firstAgent = lastEnvelope(first.writes).agentIri;

    const { ctx, io } = context({ argv: initArgv(h), home: h.home, password: PASSWORD });
    await createCeremonyCommand(h.deps).run(ctx);
    expect(lastEnvelope(io.writes).agentIri).toBe(firstAgent);
  });
});

describe('ceremony join', () => {
  async function seededGenesis(): Promise<{ readonly a: Harness; readonly genesis: string }> {
    const a = harness();
    const { ctx } = context({ argv: initArgv(a, ['--execute']), home: a.home, password: PASSWORD });
    const io = captureIo();
    await createCeremonyCommand(a.deps).run({ ...ctx, writer: io.writer, exit: io.exit });
    return { a, genesis: String(lastEnvelope(io.writes).policyGenesisDigest) };
  }

  function joinArgv(a: Harness, bDir: string, genesis: string, extra: string[] = []): string[] {
    return [
      'join',
      '--dir', bDir,
      '--role-sets', 'requester,solver',
      '--catalog', join(a.dir, 'trust.json'),
      '--genesis', genesis,
      '--authority-store', a.authorityStore,
      ...extra,
    ];
  }

  it('appends a policy successor without moving the genesis digest', async () => {
    const { a, genesis } = await seededGenesis();
    const bDir = join(a.home, '.jinn-client-op-b');
    mkdirSync(bDir, { recursive: true });

    const { ctx, io } = context({
      argv: joinArgv(a, bDir, genesis, ['--execute']),
      home: a.home,
      password: PASSWORD,
    });
    await createCeremonyCommand(a.deps).run(ctx);

    const result = lastEnvelope(io.writes);
    expect(result.kind).toBe('ceremony_join_complete');
    expect(result.policyGenesisDigest).toBe(genesis);
    expect(result.genesisDigestStable).toBe(true);
    expect(result.newestPolicyVersion).toBe(2);

    // A's config is untouched by B's join — that is the whole point of a stable genesis digest.
    const aConfig = JSON.parse(readFileSync(a.configPath, 'utf-8')) as Record<string, unknown>;
    expect(aConfig.trustPolicyGenesisDigest).toBe(genesis);
  });

  /**
   * §4.4: B runs `--role-sets requester,solver` and provisions no admission custody, so it must not
   * claim an admission authority — the runtime refuses an admissionAgent with no store behind it.
   */
  it('writes no admissionAgent for a join that provisions no admission family', async () => {
    const { a, genesis } = await seededGenesis();
    const bDir = join(a.home, '.jinn-client-op-b');
    mkdirSync(bDir, { recursive: true });

    const { ctx } = context({ argv: joinArgv(a, bDir, genesis, ['--execute']), home: a.home, password: PASSWORD });
    await createCeremonyCommand(a.deps).run(ctx);

    const bConfig = JSON.parse(readFileSync(join(bDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(bConfig.admissionAgent).toBeUndefined();
    expect(bConfig.agentIri).toMatch(/^urn:uuid:/u);
    expect(bConfig.identityStores).toEqual({
      requester: join(bDir, 'identity', 'requester.enc.json'),
      solver: join(bDir, 'identity', 'solver.enc.json'),
    });
    expect(bConfig.trustPolicyGenesisDigest).toBe(genesis);
  });

  it('refuses a --genesis pin that does not match the catalog', async () => {
    const { a } = await seededGenesis();
    const bDir = join(a.home, '.jinn-client-op-b');
    mkdirSync(bDir, { recursive: true });

    const { ctx, io } = context({
      argv: joinArgv(a, bDir, `sha256:${'9'.repeat(64)}`, ['--execute']),
      home: a.home,
      password: PASSWORD,
    });
    await createCeremonyCommand(a.deps).run(ctx);
    expect(String(lastEnvelope(io.writes).message)).toContain('does not match the catalog');
  });

  it('requires a --genesis pin at all', async () => {
    const { a } = await seededGenesis();
    const bDir = join(a.home, '.jinn-client-op-b');
    mkdirSync(bDir, { recursive: true });
    const { ctx, io } = context({
      argv: [
        'join', '--dir', bDir, '--role-sets', 'requester,solver',
        '--catalog', join(a.dir, 'trust.json'), '--authority-store', a.authorityStore,
      ],
      home: a.home,
      password: PASSWORD,
    });
    await createCeremonyCommand(a.deps).run(ctx);
    expect(String(lastEnvelope(io.writes).message)).toContain('--genesis');
  });

  it('plans without side effects and states the file-copy plus restart distribution', async () => {
    const { a, genesis } = await seededGenesis();
    const bDir = join(a.home, '.jinn-client-op-b');
    mkdirSync(bDir, { recursive: true });

    const { ctx, io } = context({ argv: joinArgv(a, bDir, genesis), home: a.home, password: PASSWORD });
    await createCeremonyCommand(a.deps).run(ctx);

    const result = lastEnvelope(io.writes);
    expect(result.kind).toBe('ceremony_join_plan');
    expect(result.sideEffects).toBe(false);
    expect(result.currentPolicyVersion).toBe(1);
    expect(result.restartRequired).toBe(true);
    expect(existsSync(join(bDir, 'identity'))).toBe(false);
    expect(existsSync(join(bDir, 'config.json'))).toBe(false);
  });
});

describe('ceremony show', () => {
  it('reports the catalog, its purposes, and what the config still needs', async () => {
    const a = harness();
    const seed = context({ argv: initArgv(a, ['--execute']), home: a.home, password: PASSWORD });
    await createCeremonyCommand(a.deps).run(seed.ctx);
    const genesis = String(lastEnvelope(seed.io.writes).policyGenesisDigest);

    const { ctx, io } = context({
      argv: ['show', '--dir', a.dir, '--catalog', join(a.dir, 'trust.json')],
      home: a.home,
    });
    await createCeremonyCommand(a.deps).run(ctx);

    const result = lastEnvelope(io.writes);
    expect(result.kind).toBe('ceremony_show');
    expect(result.policyGenesisDigest).toBe(genesis);
    expect(result.newestPolicyVersion).toBe(1);
    expect(typeof result.refreshByDaysRemaining).toBe('number');
    expect(Object.keys(result.purposes as object)).toContain('evaluator-eligibility');
    expect((result.wiring as { genesisPinMatchesCatalog: boolean }).genesisPinMatchesCatalog).toBe(true);
    // Anchors read as unknown when no live-RPC dep is supplied, rather than being silently omitted.
    expect((result.anchors as { status: string }[])[0]!.status).toBe('unknown');
    // What still stands between this config and a native boot.
    expect(result.missing).toContain('ipfs.apiUrl');
    expect(result.missing).toContain('compositionMode: "native"');
  });

  it('refuses a missing catalog path', async () => {
    const a = harness();
    const { ctx, io } = context({
      argv: ['show', '--dir', a.dir, '--catalog', join(a.dir, 'nope.json')],
      home: a.home,
    });
    await createCeremonyCommand(a.deps).run(ctx);
    expect(String(lastEnvelope(io.writes).message)).toContain('no trust catalog at');
  });

  it('refuses --store without JINN_PASSWORD', async () => {
    const a = harness();
    const seed = context({ argv: initArgv(a, ['--execute']), home: a.home, password: PASSWORD });
    await createCeremonyCommand(a.deps).run(seed.ctx);

    const { ctx, io } = context({
      argv: ['show', '--dir', a.dir, '--catalog', join(a.dir, 'trust.json'), '--store', join(a.dir, 'identity', 'solver.enc.json')],
      home: a.home,
    });
    await createCeremonyCommand(a.deps).run(ctx);
    expect(String(lastEnvelope(io.writes).message)).toContain('requires JINN_PASSWORD');
  });

  it('lists a store\'s role -> did:key ids with a password and a named family', async () => {
    const a = harness();
    const seed = context({ argv: initArgv(a, ['--execute']), home: a.home, password: PASSWORD });
    await createCeremonyCommand(a.deps).run(seed.ctx);

    const { ctx, io } = context({
      argv: [
        'show', '--dir', a.dir, '--catalog', join(a.dir, 'trust.json'),
        '--store', join(a.dir, 'identity', 'solver.enc.json'), '--role-sets', 'solver',
      ],
      home: a.home,
      password: PASSWORD,
    });
    await createCeremonyCommand(a.deps).run(ctx);

    const stores = lastEnvelope(io.writes).stores as { role: string; keyId: string }[];
    expect(stores.map(({ role }) => role).sort()).toEqual(['solver-delivery', 'solver-discovery', 'solver-settlement']);
    for (const entry of stores) expect(entry.keyId).toMatch(/^did:key:z/u);
    // Public material only — the same posture as `native-vertical identity`.
    expect(JSON.stringify(stores)).not.toContain('privateKey');
  });

  it('refuses --store with the wrong password', async () => {
    const a = harness();
    const seed = context({ argv: initArgv(a, ['--execute']), home: a.home, password: PASSWORD });
    await createCeremonyCommand(a.deps).run(seed.ctx);

    const { ctx, io } = context({
      argv: [
        'show', '--dir', a.dir, '--catalog', join(a.dir, 'trust.json'),
        '--store', join(a.dir, 'identity', 'solver.enc.json'), '--role-sets', 'solver',
      ],
      home: a.home,
      password: 'not-the-password',
    });
    await createCeremonyCommand(a.deps).run(ctx);
    expect(String(lastEnvelope(io.writes).message)).toContain('could not be listed');
  });
});

describe('ceremonyAnchorDigest', () => {
  /**
   * The catalog schema constrains only that the anchor transaction's calldata equals the declared
   * digest — never what the digest is OF. Committing to the key set makes the on-chain transaction
   * say something checkable instead of being an opaque constant.
   */
  it('commits to the agent, safe, and key set, and is order-independent', () => {
    const base = {
      agentIri: 'urn:uuid:00000000-0000-4000-8000-00000000000a',
      safeAddress: SAFE,
      keys: [{ role: 'solver-delivery', keyId: 'did:key:zA' }, { role: 'admission', keyId: 'did:key:zB' }],
    };
    const digest = ceremonyAnchorDigest(base);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(ceremonyAnchorDigest({ ...base, keys: [...base.keys].reverse() })).toBe(digest);
    expect(ceremonyAnchorDigest({ ...base, safeAddress: AGENT_EOA })).not.toBe(digest);
    expect(ceremonyAnchorDigest({ ...base, agentIri: 'urn:uuid:00000000-0000-4000-8000-00000000000b' }))
      .not.toBe(digest);
    expect(ceremonyAnchorDigest({ ...base, keys: [{ role: 'solver-delivery', keyId: 'did:key:zC' }] }))
      .not.toBe(digest);
  });
});
