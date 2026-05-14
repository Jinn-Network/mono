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
 *   - Real CLI dispatch (jinn create / pack / solver-nets add-plugin)
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
import { loadSolverPluginManifest } from '../../src/plugins/manifest.js';
import { digestDirectory } from '../../src/plugins/digest.js';
import { PLUGIN_PAYLOAD_TUPLE } from '../../src/erc8004/abis.js';
import { pinFileToIpfs } from '../../src/adapters/mech/ipfs-pinfile.js';

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
 * (client/src/harnesses/engine/envelope-assembly.ts). This test helper
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
      { rpcUrl: anvil.rpcUrl, solverNets: { 'swe-rebench-v2': { solverType: 'swe-rebench-v2.v1', enabled: true } } },
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

    // ── Step 6: operator installs the plug-in ─────────────────────────────
    const addPluginOutput: string[] = [];
    await runCli([
      'solver-nets', 'add-plugin', 'swe-rebench-v2',
      `local:${scaffoldRoot}`,
      '--config', opConfigPath,
    ], {
      writer: { write: (s: string) => { addPluginOutput.push(s); return true; } },
      exit: (code: number) => { if (code !== 0) throw new Error(`solver-nets add-plugin exited ${code}: ${addPluginOutput.join('')}`); },
    });

    const opCfg = JSON.parse(readFileSync(opConfigPath, 'utf8')) as {
      solverNets?: { 'swe-rebench-v2'?: { plugins?: string[] } };
    };
    const net = opCfg.solverNets?.['swe-rebench-v2'];
    expect(net?.plugins).toBeDefined();
    expect(net!.plugins!.some((p) => p.includes('diffmin-clone'))).toBe(true);

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
