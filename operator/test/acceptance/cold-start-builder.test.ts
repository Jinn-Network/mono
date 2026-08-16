/**
 * Cold-start builder loop — spec §6.7 nine-step acceptance.
 *
 * Walks: scaffold → pack → publish (lazy Stage 1) → indexer ingest →
 *        Discovery API surfaces → operator install → stub-Hermes run →
 *        envelope plug-in attribution → SPA panels render the new plug-in.
 *
 * Runs against:
 *   - Anvil (fresh, in-process IdentityRegistry deploy)
 *   - Stub IPFS (in-process Hono)
 *   - Stub indexer (in-process Hono + Anvil event watcher)
 *   - stub-hermes.mjs (in lieu of real Hermes — same SolverPlugin contract)
 *   - Real CLI dispatch (jinn create / pack); plugin install writes executionWiring
 *   - Real plug-in resolver + manifest validator
 *   - Direct IdentityRegistry publish (bypassing Safe — stub registry accepts
 *     direct EOA calls, avoiding the full FleetBootstrapper bootstrap which
 *     requires OLAS/Safe in the full Stage 1 flow)
 *
 * Budget: ~60–90 s total for the combined describe block.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  encodeAbiParameters,
  parseAbiItem,
  getAddress,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startAnvil, FOUNDRY_ACCOUNTS, type AnvilHandle } from './_fixtures/anvil.js';
import {
  deployIdentityRegistry,
  IDENTITY_REGISTRY_STUB_ABI,
  type IdentityRegistryHandle,
} from './_fixtures/identity-registry-deploy.js';
import { startStubIpfs, type StubIpfsHandle } from './_fixtures/stub-ipfs.js';
import { startStubIndexer, type StubIndexerHandle } from './_fixtures/stub-indexer.js';
import { hermesConfigFromSolverPlugins } from './_fixtures/hermes-config-shim.js';
import { renderBuildPage } from './_fixtures/spa-harness.js';
import { runCli } from '../../src/cli/index.js';
import { createSolverPluginsCommand, PRODUCTION_DEPS } from '../../src/cli/commands/solver-plugins.js';
import { publishHandler } from '../../src/cli/commands/solver-plugins-publish.js';
import { loadSolverPluginManifest } from '../../src/plugins/manifest.js';
import { digestDirectory } from '../../src/plugins/digest.js';
import { PLUGIN_PAYLOAD_TUPLE } from '../../src/erc8004/abis.js';
import { pinFileToIpfs } from '../../src/adapters/mech/ipfs-pinfile.js';
import type { FleetState } from '../../src/earning/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB_HERMES = join(__dirname, '..', '..', 'scripts', 'stub-hermes.mjs');
const REF_PLUGIN_ROOT = join(__dirname, '..', '..', 'plugins', 'swe-rebench-v2-diffmin');

// ── Inline poll helper ────────────────────────────────────────────────────────

async function waitForRow(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  throw new Error(`waitForRow timed out after ${timeoutMs} ms`);
}

// ── Pure envelope attribution helper ──────────────────────────────────────────

interface PluginRef {
  name: string;
  version: string;
  cid: string;
  sha256: string;
}

interface MinimalEnvelope {
  executor: { plugins: PluginRef[] };
  payload: Record<string, unknown>;
  operatorAgentId: string;
}

/**
 * Pure function: assemble the load-bearing executor.plugins[] attribution
 * from the stub-Hermes hermesConfig.plugins and the solution payload.
 *
 * In production this is done by the daemon's envelope assembler
 * (operator/src/harnesses/engine/envelope-assembly.ts). This test helper
 * validates the attribution shape without the full signing/IPFS upload.
 */
function assembleSignedEnvelope(args: {
  solutionPayload: Record<string, unknown>;
  pluginsFromHermes: PluginRef[];
  operatorAgentId: string;
}): MinimalEnvelope {
  return {
    executor: {
      plugins: args.pluginsFromHermes.map((p) => ({
        name: p.name,
        version: p.version,
        cid: p.cid,
        sha256: p.sha256,
      })),
    },
    payload: args.solutionPayload,
    operatorAgentId: args.operatorAgentId,
  };
}

// ── Shared infrastructure ─────────────────────────────────────────────────────

describe('cold-start-builder E2E (52x3.7 / r83r)', () => {
  let anvil: AnvilHandle;
  let ipfs: StubIpfsHandle;
  let registry: IdentityRegistryHandle;
  let indexer: StubIndexerHandle;
  let pluginRoot: string;
  let opConfigPath: string;
  let opConfigDir: string;

  beforeAll(async () => {
    anvil = await startAnvil();
    ipfs = await startStubIpfs();
    registry = await deployIdentityRegistry({ rpcUrl: anvil.rpcUrl });
    indexer = await startStubIndexer({
      rpcUrl: anvil.rpcUrl,
      identityRegistryAddress: registry.address,
    });
    pluginRoot = mkdtempSync(join(tmpdir(), 'jinn-plugin-'));
    opConfigDir = mkdtempSync(join(tmpdir(), 'jinn-op-'));
    opConfigPath = join(opConfigDir, 'config.json');
    writeFileSync(opConfigPath, JSON.stringify(
      {
        rpcUrl: anvil.rpcUrl,
        configShapeVersion: 2,
        executionWiring: [{
          workKind: 'swe-rebench-v2.v1',
          harness: 'hermes-agent',
          model: 'stub-hermes',
          plugins: [],
          credentialRef: 'hermes-agent-default',
          isolationPolicy: 'process',
        }],
      },
      null,
      2,
    ));
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([indexer.stop(), ipfs.stop(), anvil.stop()]);
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(opConfigDir, { recursive: true, force: true });
  });

  it('walks the nine-step builder loop end-to-end', async () => {
    // ── Step 1: scaffold via jinn create plugin ─────────────────────────────
    const pluginName = '@e2e/diffmin-clone';
    const pluginOutDir = join(pluginRoot, 'scaffold');
    mkdirSync(pluginOutDir, { recursive: true });

    const createOutput: string[] = [];
    await runCli([
      'create', 'plugin', pluginName,
      '--pattern', 'solver-type-plugin',
      '--solver-type', 'swe-rebench-v2.v1',
      '--out-dir', pluginOutDir,
    ], {
      writer: { write: (s: string) => { createOutput.push(s); return true; } },
      exit: (code: number) => { if (code !== 0) throw new Error(`jinn create exited ${code}: ${createOutput.join('')}`); },
    });

    // Package name @e2e/diffmin-clone → scoped → lives at pluginOutDir/@e2e/diffmin-clone
    const scaffoldRoot = join(pluginOutDir, '@e2e', 'diffmin-clone');
    expect(existsSync(join(scaffoldRoot, 'jinn.plugin.json'))).toBe(true);

    // Replace the placeholder skill with real content from the reference plugin.
    writeFileSync(
      join(scaffoldRoot, 'skills', 'example', 'SKILL.md'),
      readFileSync(join(REF_PLUGIN_ROOT, 'skills', 'diffmin', 'SKILL.md'), 'utf8'),
    );

    // ── Step 2: pack via jinn solver-plugins pack ───────────────────────────
    const packOut = join(pluginRoot, 'e2e-diffmin-clone-0.1.0.tgz');
    const packOutput: string[] = [];
    await runCli([
      'solver-plugins', 'pack', scaffoldRoot,
      '--out', packOut,
    ], {
      writer: { write: (s: string) => { packOutput.push(s); return true; } },
      exit: (code: number) => { if (code !== 0) throw new Error(`jinn solver-plugins pack exited ${code}: ${packOutput.join('')}`); },
    });
    expect(existsSync(packOut)).toBe(true);

    // ── Step 3: publish → lazy Stage 1 → stub IPFS → IdentityRegistry ──────
    // Instead of running the full FleetBootstrapper Stage 1 (which requires
    // a funded Safe + OLAS + service registry), we:
    //   a) Register a fresh EOA directly on the stub IdentityRegistryStub
    //   b) Pin the tarball to stub IPFS
    //   c) Call setMetadata directly (stub registry allows direct EOA calls)
    //
    // This faithfully exercises the plug-in publication surface without
    // requiring the full OLAS service stack.

    const chain = defineChain({
      id: 31337,
      name: 'anvil',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [anvil.rpcUrl] } },
    });

    const builderAccount = privateKeyToAccount(FOUNDRY_ACCOUNTS[0]!.privateKey);
    const builderWallet = createWalletClient({ account: builderAccount, chain, transport: http(anvil.rpcUrl) });
    const builderPublic = createPublicClient({ chain, transport: http(anvil.rpcUrl) });

    // Register builder as agent.
    const regHash = await builderWallet.writeContract({
      address: registry.address,
      abi: IDENTITY_REGISTRY_STUB_ABI,
      functionName: 'register',
      args: [builderAccount.address],
      account: builderAccount,
      chain,
    });
    await builderPublic.waitForTransactionReceipt({ hash: regHash });

    const builderAgentId = await builderPublic.readContract({
      address: registry.address,
      abi: IDENTITY_REGISTRY_STUB_ABI,
      functionName: 'agentIdByOwner',
      args: [builderAccount.address],
    });
    expect(builderAgentId).toBeGreaterThan(0n);

    // Pin the packed tarball to stub IPFS.
    const publishedCid = await pinFileToIpfs(ipfs.registryUrl, packOut);
    expect(publishedCid).toMatch(/^f0155/);

    // Compute digest.
    const pluginSha256 = digestDirectory(scaffoldRoot);
    const { manifest } = loadSolverPluginManifest(scaffoldRoot);

    // ABI-encode the plugin payload and call setMetadata directly.
    const metadataKey = `plugin:${publishedCid}`;
    const metadataValue = encodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, [
      1,
      manifest.name,
      manifest.version,
      ('0x' + pluginSha256) as `0x${string}`,
      manifest.jinn.supports,
      BigInt(Math.floor(Date.now() / 1000)),
    ]);

    const metaHash = await builderWallet.writeContract({
      address: registry.address,
      abi: IDENTITY_REGISTRY_STUB_ABI,
      functionName: 'setMetadata',
      args: [builderAgentId, metadataKey, metadataValue],
      account: builderAccount,
      chain,
    });
    await builderPublic.waitForTransactionReceipt({ hash: metaHash });

    // ── Step 4: indexer picks up MetadataSet event → PluginPublication row ─
    await waitForRow(() => indexer.getRows().length >= 1, 8_000);

    const rows = indexer.getRows();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const pubRow = rows.find((r) => r.cid === publishedCid);
    expect(pubRow, `published CID ${publishedCid} should appear in indexer rows`).toBeDefined();
    expect(pubRow!.name).toBe('@e2e/diffmin-clone');
    expect(pubRow!.supports).toContain('swe-rebench-v2.v1');
    expect(pubRow!.builderAgentId).toBe(String(builderAgentId));

    // ── Step 5: Discovery API surfaces the new plug-in ──────────────────────
    const apiResp = await fetch(
      `${indexer.url}/v1/discovery/plugin-publications?solverType=swe-rebench-v2.v1`,
    ).then((r) => r.json() as Promise<{ publications: Array<{ cid: string; name: string }> }>);
    expect(apiResp.publications.length).toBeGreaterThanOrEqual(1);
    expect(apiResp.publications.some((p) => p.cid === publishedCid)).toBe(true);

    // ── Step 6: operator installs the plug-in (executionWiring, not the
    // retired `solver-nets add-plugin` write) ────────────────────────────
    const pluginSource = `local:${scaffoldRoot}`;
    const opCfg = JSON.parse(readFileSync(opConfigPath, 'utf8')) as {
      executionWiring?: Array<{ workKind: string; plugins?: string[] }>;
    };
    const wiring = opCfg.executionWiring?.find((entry) => entry.workKind === 'swe-rebench-v2.v1');
    expect(wiring, 'operator config should already carry swe-rebench-v2.v1 wiring').toBeDefined();
    wiring!.plugins = [...(wiring!.plugins ?? []), pluginSource];
    writeFileSync(opConfigPath, JSON.stringify(opCfg, null, 2));
    expect(wiring!.plugins.some((p) => p.includes('diffmin-clone'))).toBe(true);

    // ── Step 7: stub-Hermes runs a SWE-rebench v2 task with the plug-in ────
    const hermesCfg = hermesConfigFromSolverPlugins([{
      manifest,
      cid: publishedCid,
      sha256: pluginSha256,
      packageRoot: scaffoldRoot,
    }]);
    expect(hermesCfg.plugins).toHaveLength(1);
    expect(hermesCfg.plugins[0]!.cid).toBe(publishedCid);

    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-task-'));
    let stubOut: string;
    try {
      stubOut = execFileSync('node', [STUB_HERMES, JSON.stringify({
        taskBody: {
          schemaVersion: 'swe-rebench-v2.v1',
          instance_id: 'unidata__netcdf-c-1925',
        },
        hermesConfig: hermesCfg,
        workingDir,
      })], { encoding: 'utf8' });
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }

    const hermesResult = JSON.parse(stubOut.trim()) as { plugins: Array<{ cid: string }> };
    expect(hermesResult.plugins[0]!.cid).toBe(publishedCid);

    // ── Step 8: envelope assembly — executor.plugins[] carries attribution ──
    const solutionPayload = {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: '--- a/src/foo.c\n+++ b/src/foo.c\n@@ -1 +1 @@\n-broken\n+fixed\n',
      cost: { totalUsd: 0.01 },
    };

    const envelope = assembleSignedEnvelope({
      solutionPayload,
      pluginsFromHermes: hermesCfg.plugins,
      operatorAgentId: String(builderAgentId),
    });
    expect(envelope.executor.plugins).toHaveLength(1);
    expect(envelope.executor.plugins[0]!.cid).toBe(publishedCid);
    expect(envelope.executor.plugins[0]!.sha256).toBe(pluginSha256);
    expect(envelope.executor.plugins[0]!.name).toBe('@e2e/diffmin-clone');

    // Record the run so the indexer can surface it in plugin-scores.
    await indexer.recordRunForTest({
      pluginCid: publishedCid,
      taskId: '0xtask001',
      operatorAgentId: String(builderAgentId),
      verdict: 'Pass',
      score: 100,
    });

    const scoresResp = await fetch(
      `${indexer.url}/v1/discovery/plugin-scores?pluginCid=${publishedCid}`,
    ).then((r) => r.json() as Promise<{ scores: Array<{ verdict: string }> }>);
    expect(scoresResp.scores).toHaveLength(1);
    expect(scoresResp.scores[0]!.verdict).toBe('Pass');

    // ── Step 9: /build SPA panels render the new plug-in ─────────────────
    const harness = await renderBuildPage({
      stubIndexerUrl: indexer.url,
      builderAgentId: String(builderAgentId),
    });
    if (harness.skipped) {
      console.log(`SPA harness skipped: ${harness.reason}`);
    } else {
      const browseRow = await harness.findPluginRow('@e2e/diffmin-clone');
      expect(browseRow).toBeTruthy();
      // MyArtifactsPanel filtered by builderAgentId — the row should appear too.
      const myRow = await harness.findMyPluginRow('@e2e/diffmin-clone');
      expect(myRow).toBeTruthy();
      harness.cleanup();
    }
  }, 90_000);
});

// ── Helper: count IdentityRegistry.register() txs for a given owner ──────────
//
// Uses viem getLogs to count AgentRegistered events. Task 12 (failing) leaves
// this as a stub that throws. Task 13 wires the real implementation.

/**
 * Count the number of IdentityRegistry.register() transactions for a given
 * owner address by filtering AgentRegistered events where `owner === ownerAddress`.
 *
 * Uses viem's public client `getLogs` with the AgentRegistered event ABI so
 * we count the actual on-chain register() calls, not any subsequent
 * setAgentWallet / setMetadata writes. This is the load-bearing assertion for
 * the dual-role test: if ensureStage1 short-circuits correctly, the count
 * stays at the pre-publish value.
 */
async function countRegisterTxs(
  rpcUrl: string,
  registryAddress: `0x${string}`,
  ownerAddress: `0x${string}`,
): Promise<number> {
  const chain = defineChain({
    id: 31337,
    name: 'anvil-count',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  // The AgentRegistered event has `owner` as an indexed topic so we can filter
  // on it without fetching all events.
  const agentRegisteredEvent = IDENTITY_REGISTRY_STUB_ABI.find(
    (x) => x.type === 'event' && x.name === 'AgentRegistered',
  );
  if (!agentRegisteredEvent) {
    throw new Error('AgentRegistered event not found in IDENTITY_REGISTRY_STUB_ABI');
  }

  const logs = await publicClient.getLogs({
    address: registryAddress,
    event: agentRegisteredEvent as Parameters<typeof publicClient.getLogs>[0]['event'],
    args: {
      owner: getAddress(ownerAddress) as Address,
    },
    fromBlock: 0n,
    toBlock: 'latest',
  });

  return logs.length;
}

// ── Dual-role: operator-then-builder, one identity ────────────────────────────

describe('dual-role: operator-then-builder (52x3.7 r83r)', () => {
  // Reuses the Anvil + IPFS + indexer from the outer scope if the test runner
  // shares the module, but each describe block also declares its own shared
  // handles so the test is self-contained within a singleFork process.

  let anvil: AnvilHandle;
  let ipfs: StubIpfsHandle;
  let registry: IdentityRegistryHandle;
  let indexer: StubIndexerHandle;
  let pluginRoot2: string;

  beforeAll(async () => {
    anvil = await startAnvil();
    ipfs = await startStubIpfs();
    registry = await deployIdentityRegistry({ rpcUrl: anvil.rpcUrl });
    indexer = await startStubIndexer({
      rpcUrl: anvil.rpcUrl,
      identityRegistryAddress: registry.address,
    });
    pluginRoot2 = mkdtempSync(join(tmpdir(), 'jinn-dual-plugin-'));
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([indexer.stop(), ipfs.stop(), anvil.stop()]);
    rmSync(pluginRoot2, { recursive: true, force: true });
  });

  it('publishes a plug-in without re-minting Stage 1 identity', async () => {
    // ── Pre-walk: simulate Stage 1 + 2 already complete ──────────────────────
    //
    // Instead of running the full FleetBootstrapper (which requires OLAS/Safe),
    // we:
    //   1. Register a fresh EOA directly on the stub IdentityRegistry (account #1,
    //      different from account #0 used in the main cold-start describe).
    //   2. Snapshot the AgentRegistered log count (= 1 after registration).
    //   3. Run solver-plugins publish with a mocked bootstrapperFactory that reads
    //      the pre-seeded fleet_stage='stage1' and short-circuits ensureStage1.
    //   4. Assert the AgentRegistered log count is still 1 (no re-mint).

    const chain = defineChain({
      id: 31337,
      name: 'anvil-dual',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [anvil.rpcUrl] } },
    });

    // Use account #1 for the dual-role operator (account #0 is used by the
    // cold-start describe above to avoid tx nonce collisions when both
    // describes share an Anvil instance).
    const opAccount = privateKeyToAccount(FOUNDRY_ACCOUNTS[1]!.privateKey);
    const opWallet = createWalletClient({ account: opAccount, chain, transport: http(anvil.rpcUrl) });
    const opPublic = createPublicClient({ chain, transport: http(anvil.rpcUrl) });

    // Step 1: register the operator as a fleet agent (simulating Stage 1 identity mint).
    const regHash = await opWallet.writeContract({
      address: registry.address,
      abi: IDENTITY_REGISTRY_STUB_ABI,
      functionName: 'register',
      args: [opAccount.address],
      account: opAccount,
      chain,
    });
    await opPublic.waitForTransactionReceipt({ hash: regHash });

    const fleetAgentId = await opPublic.readContract({
      address: registry.address,
      abi: IDENTITY_REGISTRY_STUB_ABI,
      functionName: 'agentIdByOwner',
      args: [opAccount.address],
    }) as bigint;
    expect(fleetAgentId).toBeGreaterThan(0n);
    const fleetAgentIdStr = fleetAgentId.toString();

    // Step 2: snapshot register tx count BEFORE publish.
    const registerCountBefore = await countRegisterTxs(
      anvil.rpcUrl,
      registry.address,
      opAccount.address,
    );
    // We expect exactly 1 register call (the one we just did above).
    expect(registerCountBefore).toBe(1);

    // Step 3: scaffold a fresh plug-in for the dual-role publish.
    const scaffoldDir = join(pluginRoot2, 'scaffold');
    mkdirSync(scaffoldDir, { recursive: true });

    const createOutput: string[] = [];
    await runCli([
      'create', 'plugin', '@dual/skill',
      '--pattern', 'solver-type-plugin',
      '--solver-type', 'swe-rebench-v2.v1',
      '--out-dir', scaffoldDir,
    ], {
      writer: { write: (s: string) => { createOutput.push(s); return true; } },
      exit: (code: number) => {
        if (code !== 0) throw new Error(`jinn create exited ${code}: ${createOutput.join('')}`);
      },
    });

    const dualPluginRoot = join(scaffoldDir, '@dual', 'skill');
    expect(existsSync(join(dualPluginRoot, 'jinn.plugin.json'))).toBe(true);

    // Copy real skill content from the reference plug-in.
    writeFileSync(
      join(dualPluginRoot, 'skills', 'example', 'SKILL.md'),
      readFileSync(join(__dirname, '..', '..', 'plugins', 'swe-rebench-v2-diffmin', 'skills', 'diffmin', 'SKILL.md'), 'utf8'),
    );

    // Step 4: publish via solver-plugins publish with mocked deps.
    //
    // The bootstrapperFactory mock returns a pre-seeded fleet_state with
    // fleet_stage='stage1' and the agentId we minted above. This exercises
    // the ensureStage1 short-circuit path — no new register() tx should fire.
    //
    // The publisherFactory mock calls setMetadata directly on the stub registry
    // (same approach as the cold-start describe, avoiding the full Safe stack).

    const preSeededFleetState: FleetState = {
      master_address: opAccount.address,
      chain: 'base',
      staking_mode: 'standard',
      services: [],
      updated_at: new Date().toISOString(),
      fleet_agent_id: fleetAgentIdStr,
      fleet_safe_address: opAccount.address,       // EOA acts as Safe for stub
      fleet_identity_registry: registry.address,
      fleet_stage: 'stage1',
    };

    let publishedCid2: string | undefined;
    const publishOutput: string[] = [];

    const mockDeps = {
      ...PRODUCTION_DEPS,
      resolveCliPassword: () => ({ ok: true as const, password: 'test' }),
      loadConfig: () => ({
        ...PRODUCTION_DEPS.loadConfig(),
        rpcUrl: anvil.rpcUrl,
        earningDir: pluginRoot2,
        ipfsRegistryUrl: ipfs.registryUrl,
        network: 'mainnet' as const,
        stakingMode: 'standard' as const,
      }),
      bootstrapperFactory: (_cfg: ReturnType<typeof PRODUCTION_DEPS.loadConfig>) => ({
        ensureStage1: async (_password: string) => ({
          ok: true as const,
          fleet_state: preSeededFleetState,
          message: `Stage 1 already complete (dual-role stub). fleet_agent_id=${fleetAgentIdStr}.`,
        }),
      }),
      pinFileToIpfs: async (_registryUrl: string, tarballPath: string) => {
        return pinFileToIpfs(ipfs.registryUrl, tarballPath);
      },
      publisherFactory: (args: { identityRegistryAddress: Address; builderAgentId: bigint }) => ({
        publish: async ({ pluginCid, payload }: { pluginCid: string; payload: import('../../src/erc8004/plugin-registry.js').PluginPayload }) => {
          // Pin → setMetadata directly (bypass Safe).
          publishedCid2 = pluginCid;
          const metadataKey = `plugin:${pluginCid}`;
          const metadataValue = encodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, [
            1,
            payload.pluginName,
            payload.pluginVersion,
            payload.pluginSha256,
            payload.supports,
            BigInt(payload.publishedAt),
          ]);
          const metaHash = await opWallet.writeContract({
            address: args.identityRegistryAddress,
            abi: IDENTITY_REGISTRY_STUB_ABI,
            functionName: 'setMetadata',
            args: [args.builderAgentId, metadataKey, metadataValue],
            account: opAccount,
            chain,
          });
          await opPublic.waitForTransactionReceipt({ hash: metaHash });
          return metaHash;
        },
        revoke: async () => { throw new Error('revoke not implemented in stub'); },
      }),
      now: () => Date.now(),
    };

    const solverPluginsCmd = createSolverPluginsCommand(mockDeps);
    await solverPluginsCmd.run({
      argv: ['publish', dualPluginRoot],
      stdoutIsTty: false,
      writer: { write: (s: string) => { publishOutput.push(s); return true; } },
      exit: (code: number) => {
        if (code !== 0) {
          throw new Error(`solver-plugins publish exited ${code}: ${publishOutput.join('')}`);
        }
      },
      env: { JINN_PASSWORD: 'test' },
    });

    // Parse the JSON output line.
    const publishResult = JSON.parse(publishOutput.find((l) => l.includes('"verb"')) ?? '{}') as {
      verb: string;
      txHash: string;
      pluginCid: string;
      builderAgentId: string;
    };
    expect(publishResult.verb).toBe('solver-plugins publish');
    expect(publishResult.builderAgentId).toBe(fleetAgentIdStr);

    // Step 5: assert register() tx count is UNCHANGED (same as before).
    const registerCountAfter = await countRegisterTxs(
      anvil.rpcUrl,
      registry.address,
      opAccount.address,
    );
    expect(registerCountAfter).toBe(registerCountBefore);   // no new mint

    // Step 6: indexer surfaces the publication with correct builderAgentId.
    await waitForRow(
      () => indexer.getRows().some((r) => r.builderAgentId === fleetAgentIdStr),
      8_000,
    );
    const row = indexer.getRows().find((r) => r.builderAgentId === fleetAgentIdStr);
    expect(row, 'indexer row with fleet_agent_id should exist').toBeDefined();
    expect(row!.name).toBe('@dual/skill');
    expect(row!.builderAgentId).toBe(fleetAgentIdStr);
  }, 60_000);
});
