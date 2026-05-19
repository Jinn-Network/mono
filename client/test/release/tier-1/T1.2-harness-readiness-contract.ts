import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnMultiOpDaemons, type MultiOpHandle } from '../../helpers/multi-op-daemon.js';
import { classifyFailure, type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types.js';

const KNOWN_HARNESSES = ['claude-code-learner', 'codex-code-learner', 'hermes-agent'] as const;

// Port chosen to avoid collision with conventional 7331 (default daemon),
// 17332 (multi-op helper tests), and 7732/7733/7734 (multi-op-daemon.test.ts).
const API_PORT = 27331;

// A known UI token pre-written to the HOME before spawning the daemon.
// The daemon's ensureUiToken() reads ~/.jinn-client/ui-token on startup — if
// the file already exists with a token ≥32 chars it uses that value, so we
// can predict the token without any handshake exchange round-trip.
const KNOWN_UI_TOKEN = 'test-t12-harness-readiness-contract-known-token-abc123';

interface HarnessEntry {
  harnessName: string;
  manifestCids: string[];
  ready: boolean;
  reason?: string;
  nextStep?: unknown;
}

interface HarnessSnapshot {
  lastRefreshedAt: string;
  harnesses: HarnessEntry[];
}

function assertEntryShape(name: string, entry: unknown): void {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`/v1/harnesses/${name}/readiness body is not an object`);
  }
  const e = entry as Record<string, unknown>;
  if (typeof e['harnessName'] !== 'string') {
    throw new Error(`/v1/harnesses/${name}/readiness missing harnessName: string`);
  }
  if (!Array.isArray(e['manifestCids'])) {
    throw new Error(`/v1/harnesses/${name}/readiness missing manifestCids: string[]`);
  }
  if (typeof e['ready'] !== 'boolean') {
    throw new Error(`/v1/harnesses/${name}/readiness missing ready: boolean`);
  }
  if ('reason' in e && e['reason'] !== undefined && typeof e['reason'] !== 'string') {
    throw new Error(`/v1/harnesses/${name}/readiness reason must be string when present`);
  }
  if (
    'nextStep' in e &&
    e['nextStep'] !== undefined &&
    (typeof e['nextStep'] !== 'object' || e['nextStep'] === null)
  ) {
    throw new Error(`/v1/harnesses/${name}/readiness nextStep must be an object when present`);
  }
}

export async function runT12HarnessReadinessContract(opts: ScenarioOptions): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidenceLines: string[] = [];
  const log = (msg: string): void => {
    evidenceLines.push(`[${new Date().toISOString()}] ${msg}`);
  };

  let daemons: MultiOpHandle | null = null;
  let tmpHome: string | null = null;

  try {
    log('Phase 1: prepare fresh HOME with minimal config and known UI token');
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.2-home-'));
    const jinnDir = path.join(tmpHome, '.jinn-client');
    await fs.mkdir(jinnDir, { recursive: true });
    // Minimal config; the daemon will run in setup/uninitialized mode.
    // No joinedSolverNets — harnesses array will be empty on 200 or registry
    // may still be initialising and return 503. Both are valid contract responses.
    await fs.writeFile(
      path.join(jinnDir, 'config.json'),
      JSON.stringify({ pollIntervalMs: 5000 }),
    );
    // Pre-seed the UI token so we can authenticate without a handshake exchange.
    // The daemon's ensureUiToken() reads this file on startup; if it already has
    // a valid token (≥32 chars), it uses it as-is. The x-jinn-ui-token header is
    // the non-browser equivalent of the cookie set by /auth/handshake.
    await fs.writeFile(
      path.join(jinnDir, 'ui-token'),
      KNOWN_UI_TOKEN + '\n',
      { mode: 0o600 },
    );

    log(`Phase 2: spawn daemon on port ${API_PORT}, HOME=${tmpHome}`);
    daemons = await spawnMultiOpDaemons({
      ops: [{ name: 't12', home: tmpHome, apiPort: API_PORT }],
      readyTimeoutMs: 30000,
    });
    log(`  daemon pid=${daemons.daemons['t12'].pid}`);

    const uiHeaders = { 'x-jinn-ui-token': KNOWN_UI_TOKEN };

    log('Phase 3: query /v1/harnesses/readiness (index)');
    const indexRes = await fetch(`http://127.0.0.1:${API_PORT}/v1/harnesses/readiness`, {
      headers: uiHeaders,
    });
    if (indexRes.status !== 200 && indexRes.status !== 503) {
      const text = await indexRes.text().catch(() => '<unreadable>');
      throw new Error(
        `/v1/harnesses/readiness returned ${indexRes.status} (expected 200 or 503): ${text.slice(0, 200)}`,
      );
    }
    const indexBody = (await indexRes.json()) as unknown;
    if (indexRes.status === 200) {
      const snap = indexBody as Partial<HarnessSnapshot>;
      if (
        typeof snap.lastRefreshedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T/.test(snap.lastRefreshedAt)
      ) {
        throw new Error('/v1/harnesses/readiness missing or malformed lastRefreshedAt');
      }
      if (!Array.isArray(snap.harnesses)) {
        throw new Error('/v1/harnesses/readiness missing harnesses array');
      }
      log(`  index 200: ${snap.harnesses.length} harnesses, lastRefreshedAt=${snap.lastRefreshedAt}`);
      for (const entry of snap.harnesses) {
        assertEntryShape(entry.harnessName ?? '<unknown>', entry);
      }
    } else {
      // 503
      const err = indexBody as { error?: string };
      if (err.error !== 'subsystem_not_ready') {
        throw new Error(
          `/v1/harnesses/readiness 503 body has unexpected shape: ${JSON.stringify(err)}`,
        );
      }
      log('  index 503: subsystem_not_ready (registry not yet initialised — valid contract)');
    }

    log('Phase 4: per-harness endpoints');
    for (const name of KNOWN_HARNESSES) {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/v1/harnesses/${name}/readiness`, {
        headers: uiHeaders,
      });
      const body = (await res.json().catch(() => null)) as unknown;
      if (body === null) {
        throw new Error(`/v1/harnesses/${name}/readiness body is not valid JSON`);
      }
      if (res.status === 200) {
        assertEntryShape(name, body);
        const entry = body as HarnessEntry;
        if (entry.harnessName !== name) {
          throw new Error(
            `/v1/harnesses/${name}/readiness returned harnessName=${entry.harnessName}`,
          );
        }
        log(`  ${name}: 200 ready=${entry.ready}`);
      } else if (res.status === 404) {
        const err = body as { error?: string };
        if (err.error !== 'harness_not_found') {
          throw new Error(
            `/v1/harnesses/${name}/readiness 404 body has unexpected shape: ${JSON.stringify(err)}`,
          );
        }
        log(
          `  ${name}: 404 harness_not_found (registry has no joined SolverNet referencing it — valid)`,
        );
      } else if (res.status === 503) {
        const err = body as { error?: string };
        if (err.error !== 'subsystem_not_ready') {
          throw new Error(
            `/v1/harnesses/${name}/readiness 503 body has unexpected shape: ${JSON.stringify(err)}`,
          );
        }
        log(`  ${name}: 503 subsystem_not_ready (valid)`);
      } else {
        throw new Error(
          `/v1/harnesses/${name}/readiness returned unexpected status ${res.status}`,
        );
      }
    }

    log('contract OK on all known harnesses');
    await fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));
    return {
      scenarioId: 'T1.2',
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
      scenarioId: 'T1.2',
      verdict: 'fail',
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass: classifyFailure(err),
      failNotes: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (daemons) {
      try { await daemons.teardown(); } catch { /* best-effort */ }
    }
    if (tmpHome) {
      try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

describe('T1.2 harness-readiness-contract', () => {
  it('returns pass verdict when /v1/harnesses/readiness contract holds', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.2-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T1.2.log');
    try {
      const verdict = await runT12HarnessReadinessContract({ evidencePath });
      expect(verdict.scenarioId).toBe('T1.2');
      expect(verdict.verdict).toBe('pass');
      expect(verdict.failClass).toBeNull();
      const logContent = await fs.readFile(evidencePath, 'utf-8');
      expect(logContent).toContain('contract OK');
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 90000);
});
