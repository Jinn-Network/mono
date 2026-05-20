import * as fs from 'node:fs/promises';
import { setupTier3Scenario, type Tier3Handle } from './tier-3-helpers';
import { classifyFailure, type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types';
import {
  KNOWN_INSTANCE_ID,
  KNOWN_REPO,
  KNOWN_COMMIT,
  KNOWN_EXPECTED_VERDICT,
} from '../tier-2/fixtures/known-instance';

const COST_CAP_USD = 0.25;
const WALL_CLOCK_BUDGET_MS = 10 * 60 * 1000;

interface ScenarioOptionsT3 extends ScenarioOptions {
  mode?: 'human-invoked' | 'autonomous';
  hermesModel?: string;
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  opts: { timeoutMs: number; intervalMs?: number; label?: string },
): Promise<T> {
  const interval = opts.intervalMs ?? 5000;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor${opts.label ? ` (${opts.label})` : ''} timed out after ${opts.timeoutMs}ms`);
}

export async function runT31ProducerEvaluatorReal(opts: ScenarioOptionsT3): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidenceLines: string[] = [];
  const log = (msg: string) => evidenceLines.push(`[${new Date().toISOString()}] ${msg}`);

  let handle: Tier3Handle | null = null;
  const hermesModel = opts.hermesModel ?? 'deepseek/deepseek-v4-flash';
  const budgetMs = opts.wallClockBudgetMs ?? WALL_CLOCK_BUDGET_MS;

  try {
    log(`1. setup Tier 3 scenario (mode=${opts.mode ?? 'human-invoked'}, model=${hermesModel}, budgetMs=${budgetMs})`);
    handle = await setupTier3Scenario({
      scenarioId: 'T3.1',
      mode: opts.mode ?? 'human-invoked',
      portBase: 7360,
      extraEnv: {
        JINN_HERMES_MODEL: hermesModel,
        JINN_TIER3_COST_CAP_USD: COST_CAP_USD.toString(),
      },
    });
    log('   daemons up against real Base Sepolia');

    const opAPort = handle.daemons.daemons['op-a'].apiPort;
    const opBPort = handle.daemons.daemons['op-b'].apiPort;

    log(`2. op-a posts task instance=${KNOWN_INSTANCE_ID}`);
    const postRes = await fetch(`http://127.0.0.1:${opAPort}/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        solverType: 'swe-rebench-v2.v1',
        spec: { instanceId: KNOWN_INSTANCE_ID, repo: KNOWN_REPO, commit: KNOWN_COMMIT },
      }),
    });
    if (!postRes.ok) throw new Error(`/v1/tasks returned ${postRes.status}: ${await postRes.text()}`);
    const posted = await postRes.json() as { taskId: string; requestId: string };
    log(`   taskId=${posted.taskId}, requestId=${posted.requestId}`);

    log('3. wait for op-a to claim, solve via real Hermes, deliver');
    const delivered = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${opAPort}/v1/tasks/${posted.taskId}`);
      if (!r.ok) return null;
      const body = await r.json() as { state?: string; deliveryTxHash?: string; cost?: { usd?: number } };
      return body.state === 'DELIVERED' ? body : null;
    }, { timeoutMs: 8 * 60 * 1000, intervalMs: 5000, label: 'op-a-delivery' });
    log(`   deliveryTx=${delivered.deliveryTxHash}`);
    if (delivered.cost?.usd !== undefined) {
      log(`   cost so far: $${delivered.cost.usd.toFixed(4)}`);
      if (delivered.cost.usd > COST_CAP_USD) {
        throw new Error(`cost cap exceeded: spent $${delivered.cost.usd.toFixed(4)}, cap $${COST_CAP_USD}`);
      }
    }

    log('4. wait for op-b to claim verdict request, run evaluator, post verdict');
    const verdict = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${opBPort}/v1/verdicts?taskId=${posted.taskId}`);
      if (!r.ok) return null;
      const body = await r.json() as { verdicts?: Array<{ verdictCode: number; verdictTxHash?: string; solutionCid?: string; verdictCid?: string }> };
      return body.verdicts && body.verdicts.length > 0 ? body.verdicts[0]! : null;
    }, { timeoutMs: 5 * 60 * 1000, intervalMs: 5000, label: 'op-b-verdict' });
    log(`   verdictCode=${verdict.verdictCode}, verdictTx=${verdict.verdictTxHash}`);
    log(`   solutionCid=${verdict.solutionCid}, verdictCid=${verdict.verdictCid}`);

    log('5. assert verdict matches expected');
    if (verdict.verdictCode !== KNOWN_EXPECTED_VERDICT) {
      throw new Error(`expected verdictCode=${KNOWN_EXPECTED_VERDICT}, got ${verdict.verdictCode}`);
    }
    log('   PASS — verdict matches');

    await fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));
    return {
      scenarioId: 'T3.1',
      verdict: 'pass',
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass: null,
      failNotes: null,
    };
  } catch (err) {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    await fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));
    return {
      scenarioId: 'T3.1',
      verdict: 'fail',
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass: classifyFailure(err),
      failNotes: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (handle) { try { await handle.teardown(); } catch {} }
  }
}
