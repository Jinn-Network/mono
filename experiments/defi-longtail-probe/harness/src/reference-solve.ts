// Verifier positive-path QA: each instance dir ships a harness-side
// reference.ts (`export async function solve(ctx)`) that is never mounted into
// agent workspaces. Runs setup → reference solve → verify and expects ALL
// checks to pass, so a broken/rigged verifier cannot silently floor the baseline.
// With --nullop, skips the solve step and expects at least one core:* check to
// FAIL — proving the verifier cannot be passed by doing nothing.
// Usage: tsx src/reference-solve.ts <instancesRootOrDir> [--filter substr] [--nullop]
import { readdirSync, mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnAnvil, type AnvilHandle } from './lib/anvil.js';
import { freshAccount } from './lib/chain.js';
import { FORK_BLOCKS, blockNumber, collectWalletTxs } from './lib/defi.js';
import { loadInstance, forkUrl } from './lib/trial.js';
import type { FixtureCtx, Wallet } from './lib/types.js';

async function main() {
  const argv = process.argv.slice(2);
  const root = resolve(argv.find((a) => !a.startsWith('--')) ?? '../instances/scored');
  const filter = argv.includes('--filter') ? argv[argv.indexOf('--filter') + 1] : '';
  const nullop = argv.includes('--nullop');

  const dirs = existsSync(join(root, 'instance.ts'))
    ? [root]
    : readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.includes(filter))
        .map((d) => join(root, d.name))
        .sort();

  let failures = 0;
  for (const dir of dirs) {
    const inst = await loadInstance(dir);
    const refPath = join(dir, 'reference.ts');
    if (!nullop && !existsSync(refPath)) { console.error(`[ref] ${inst.meta.id}: missing reference.ts`); failures += 1; continue; }
    const root = mkdtempSync(join(tmpdir(), 'defi-ref-'));
    const ws = join(root, 'workspace');
    mkdirSync(join(ws, 'out'), { recursive: true });
    let anvil: AnvilHandle | undefined;
    try {
      anvil = await spawnAnvil({ forkUrl: forkUrl(inst.meta.chain), forkBlock: FORK_BLOCKS[inst.meta.chain] });
      const { key, account } = freshAccount();
      const wallet: Wallet = { address: account.address as `0x${string}`, privateKey: key };
      const ctx: FixtureCtx = { workspaceDir: ws, anvil, wallet };
      const gt = await inst.setup(ctx);
      const blockAfterSetup = await blockNumber(anvil.rpcUrl);
      if (!nullop) {
        const ref = (await import(pathToFileURL(refPath).href)) as { solve: (ctx: FixtureCtx) => Promise<void> };
        await ref.solve(ctx);
      }
      // Mirror trial.ts: calldata-decoding checks read txs.json next to the workspace.
      const txs = await collectWalletTxs(anvil.rpcUrl, wallet.address, blockAfterSetup);
      writeFileSync(join(root, 'txs.json'), JSON.stringify(txs, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2));
      const checks = await inst.verify({ workspaceDir: ws, anvil, wallet, groundTruth: gt });
      if (nullop) {
        const coreFailed = checks.some((c) => c.name.startsWith('core:') && !c.pass);
        console.log(`[ref:nullop] ${inst.meta.id}: ${coreFailed ? 'CORE FAILS (good)' : 'PASSES WITH NO ACTION (RIGGED?)'} (${checks.filter((c) => c.pass).length}/${checks.length} pass)`);
        if (!coreFailed) failures += 1;
      } else {
        const allPass = checks.length > 0 && checks.every((c) => c.pass);
        console.log(`[ref] ${inst.meta.id}: ${allPass ? 'ALL PASS' : 'FAILURES'} (${checks.filter((c) => c.pass).length}/${checks.length})`);
        if (!allPass) {
          failures += 1;
          for (const c of checks.filter((x) => !x.pass)) console.log(`    fail ${c.name} ${c.detail ?? ''}`);
        }
      }
    } catch (err) {
      console.error(`[ref] ${inst.meta.id}: ERROR ${(err as Error).stack?.split('\n').slice(0, 4).join('\n')}`);
      failures += 1;
    } finally {
      await anvil?.kill().catch(() => undefined);
      rmSync(ws, { recursive: true, force: true });
    }
  }
  console.log(failures === 0 ? '[ref] PASS' : `[ref] ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
