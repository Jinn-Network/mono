import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnAnvil, type AnvilHandle } from './anvil.js';
import { runClaude } from './claude.js';
import { freshAccount } from './chain.js';
import { FORK_BLOCKS, blockNumber, collectWalletTxs } from './defi.js';
import { deriveSeverity, isPass } from './severity.js';
import type { Chain, InstanceModule, TrialResult, Wallet } from './types.js';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_MODEL = 'claude-opus-5';

/** Workspaces must live OUTSIDE the repo tree so the subprocess's project
 * settings lookup cannot find the mono CLAUDE.md. */
export const RUNS_ROOT = join(process.env.HOME ?? '/tmp', 'defi-longtail-probe-runs');

/** Committed defaults are keyless archive endpoints; export
 * DEFI_PROBE_FORK_URL_BASE / DEFI_PROBE_FORK_URL_ETH locally to use paid
 * archive gateways (never commit keys). */
export function forkUrl(chain: Chain): string {
  if (chain === 'base') {
    // Tenderly public gateway serves archive state at the pin; 1rpc.io works too but
    // exhausts its daily quota fast (QA-LOG); drpc/publicnode/llamarpc failed anvil genesis.
    return process.env.DEFI_PROBE_FORK_URL_BASE ?? process.env.DEFI_PROBE_FORK_URL ?? 'https://base.gateway.tenderly.co';
  }
  // publicnode 403s on archive-depth reads once the pin ages; drpc serves them (QA-LOG).
  return process.env.DEFI_PROBE_FORK_URL_ETH ?? 'https://eth.drpc.org';
}

export async function loadInstance(instanceDir: string): Promise<InstanceModule> {
  const mod = (await import(pathToFileURL(join(resolve(instanceDir), 'instance.ts')).href)) as InstanceModule;
  if (!mod.meta || !mod.setup || !mod.verify) throw new Error(`bad instance module: ${instanceDir}`);
  return mod;
}

export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`unknown prompt var: ${k}`);
    return vars[k];
  });
}

export async function runTrial(opts: {
  instanceDir: string;
  trial: number;
  runLabel: string;
  model?: string;
}): Promise<TrialResult> {
  const instanceDir = resolve(opts.instanceDir);
  const inst = await loadInstance(instanceDir);
  const model = opts.model ?? DEFAULT_MODEL;

  const trialRoot = join(RUNS_ROOT, opts.runLabel, inst.meta.id, `t${opts.trial}`);
  const workspaceDir = join(trialRoot, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });

  const { key, account } = freshAccount();
  const wallet: Wallet = { address: account.address as `0x${string}`, privateKey: key };

  let anvil: AnvilHandle | undefined;
  const base = {
    instance: inst.meta.id,
    family: inst.meta.family,
    chain: inst.meta.chain,
    coverage: inst.meta.coverage,
    ambiguity: inst.meta.ambiguity,
    trial: opts.trial,
    model,
  };

  try {
    anvil = await spawnAnvil({ forkUrl: forkUrl(inst.meta.chain), forkBlock: FORK_BLOCKS[inst.meta.chain] });

    const groundTruth = await inst.setup({ workspaceDir, anvil, wallet });
    const blockAfterSetup = await blockNumber(anvil.rpcUrl);
    writeFileSync(join(trialRoot, 'ground-truth.json'), JSON.stringify({ ...groundTruth, blockAfterSetup, wallet: wallet.address }, bigintReplacer, 2));

    const template = readFileSync(join(instanceDir, 'task.md'), 'utf8');
    const prompt = renderPrompt(template, {
      WALLET_ADDRESS: wallet.address,
      PRIVATE_KEY: wallet.privateKey,
      RPC_URL: anvil.rpcUrl,
    });
    writeFileSync(join(workspaceDir, 'TASK.md'), prompt);

    const run = await runClaude({
      workspaceDir,
      prompt,
      model,
      stdoutPath: join(trialRoot, 'stdout.jsonl'),
      timeoutMs: inst.meta.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    // A run the API cut short (rate limit, 5xx, auth) never got a fair attempt.
    // Scoring it would silently record an infra failure as a model failure —
    // exactly what poisoned scored-v1's first pass. Fail loudly instead; the
    // matrix runner's resume logic re-runs cells whose result.json is absent,
    // and the analyzer excludes any result carrying an `error`.
    if (run.apiError) throw new Error(`INFRA: agent run terminated by API error, not scored :: ${run.apiError}`);

    const txs = await collectWalletTxs(anvil.rpcUrl, wallet.address, blockAfterSetup);
    const gasWei = txs.reduce((acc, t) => acc + BigInt(t.gasUsed) * BigInt(t.effectiveGasPrice), 0n);
    // Verifiers that decode historical calldata (e.g. approve amounts) read this.
    writeFileSync(join(trialRoot, 'txs.json'), JSON.stringify(txs, bigintReplacer, 2));
    const checks = await inst.verify({ workspaceDir, anvil, wallet, groundTruth });
    const score = checks.length === 0 ? 0 : checks.filter((c) => c.pass).length / checks.length;
    const severity = deriveSeverity(checks, txs.some((t) => t.status === 'success'));

    const result: TrialResult = {
      ...base,
      score,
      pass: isPass(severity),
      severity,
      checks,
      txs,
      gasWei: gasWei.toString(),
      agentExitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      tokenCostUsd: run.tokenCostUsd,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      numTurns: run.numTurns,
      webSearchCount: run.webSearchCount,
      webFetchCount: run.webFetchCount,
    };
    writeFileSync(join(trialRoot, 'result.json'), JSON.stringify(result, bigintReplacer, 2));
    return result;
  } catch (err) {
    const result: TrialResult = {
      ...base,
      score: 0,
      pass: false,
      severity: 'clean-fail',
      checks: [],
      txs: [],
      gasWei: '0',
      agentExitCode: null,
      timedOut: false,
      durationMs: 0,
      tokenCostUsd: null,
      inputTokens: null,
      outputTokens: null,
      numTurns: null,
      webSearchCount: 0,
      webFetchCount: 0,
      error: `${(err as Error).stack ?? err}`,
    };
    writeFileSync(join(trialRoot, 'result.json'), JSON.stringify(result, bigintReplacer, 2));
    return result;
  } finally {
    await anvil?.kill().catch(() => undefined);
  }
}

export function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

export function instanceLabel(dir: string): string {
  return basename(resolve(dir));
}
