import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnMultiOpDaemons, type MultiOpHandle } from '../../helpers/multi-op-daemon.js';
import { runScenario, type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types.js';

const KNOWN_HARNESSES = ['claude-code-learner', 'codex-code-learner', 'hermes-agent'] as const;

// ── Fixed below-band port registry ──────────────────────────────────────────
//
// Vitest runs ~850 test files across 3 forked workers, and those workers share
// one kernel-global 127.0.0.1 port space. A fixed port is therefore only safe
// BELOW the ephemeral band (32768-65535 -- the union of the Linux
// `ip_local_port_range` default 32768-60999 and the macOS range 49152-65535):
// under the band, no sibling worker's `listen(0)` can ever be handed it.
//
// Below the band, a fixed reservation BEATS `allocateAnvilPort()` for a
// child-process bind, because it has no allocate-then-rebind window at all.
// The price is that the number must be unique repo-wide, so every one of them
// is recorded here. `yarn lint:no-fixed-test-port` enforces the band, not this
// list -- the list is maintained by hand, and a wrong entry is how the next
// reservation collides. Verified against the tree 2026-08-29; the 7350/7351,
// 7360/7361, 7388, 7389 and 17398-17400 rows were missing from earlier passes,
// and the 7350/7351 double-booking below was found by the same re-walk.
//
//   7331          default daemon apiPort -- the conventional one, referenced by
//                 ~26 call sites (config fixtures, doctor, harness URLs)
//   7350 / 7351   DOUBLE-BOOKED, and the one row here that is not unique.
//                 test/release/tier-3/tier-3-helpers.ts -- the DEFAULT
//                 `opts.portBase ?? 7350`, i.e. every tier-3 scenario that does
//                 not pass its own portBase (solver takes portBase + 1) -- AND
//                 scripts/release/stage1-closed-loop.ts:60-61, `EVALUATOR_PORT`
//                 / `SOLVER_PORT`, which bind the same pair. Safe only because
//                 stage1-closed-loop is a hand-run release script that never
//                 runs concurrently with the vitest suite. Do not reuse either
//                 number, and collapse this row onto one owner the next time
//                 stage1-closed-loop is touched.
//   7360 / 7361   test/release/tier-3/T3.1-producer-evaluator-real.ts --
//                 `PORT_BASE`, passed to setupTier3Scenario, which spawns two
//                 real daemons on portBase / portBase + 1
//   7388          scripts/release/olas-rails-smoke.ts:19 -- `DEFAULT_GAMMA_PORT`,
//                 the local Gamma fixture, bound at :318 via
//                 `server.listen(port, '127.0.0.1', ...)`
//   7389          scripts/release/stage1-closed-loop.ts:62 --
//                 `DEFAULT_GAMMA_PORT`, the local Polymarket Gamma fixture,
//                 bound at :246 the same way
//   7732 / 7733   test/helpers/multi-op-daemon.test.ts -- op-a / op-b dummies
//   7734          test/helpers/multi-op-daemon.test.ts -- 'teardown is idempotent'
//   7740 / 7741   test/release/tier-2/tier-2-helpers.test.ts -- portBase 7740
//                 (op-b takes portBase + 1)
//   7742 / 7743   test/release/tier-2/tier-2-helpers.test.ts -- portBase 7742
//   9331 / 9332   test/release/tier-3/tier-3-helpers.test.ts -- the "nothing is
//                 listening here" probe; deliberately bound by nothing
//   17398-17400   test/main/degraded-daemon-guard.e2e.test.ts -- `nextPort`,
//                 handed to a spawned daemon as its apiPort. The one RANGE in
//                 this table rather than a number: `nextPort++` at :110 (called
//                 twice) and at :236 allocates three ports per run today, so it
//                 runs 17398-17400 and the next reservation must start at
//                 17401 or higher. Widen this row if a fourth spawn is added.
//   27331         THIS file -- the real daemon this scenario spawns
//
// Other below-band literals occur in the tree (7332, 7333, 7340, 7342, 7390,
// 7400, 7450, 7451, 7777, 18532, 18533) but nothing binds them: they are inert
// config values, PIDs, URLs behind a stubbed `fetch`, or -- in the case of 7390
// (scripts/release/launch-isolated-solvernet.ts:354) -- unreachable code behind
// the unconditional throw at :349. The full census lives in the doc block of
// operator/scripts/check-no-fixed-test-port.mjs.
//
// ── Which form to use ───────────────────────────────────────────────────────
//
//   1. The TEST ITSELF binds it -> `listen(0, '127.0.0.1')`, then read
//      `server.address().port`. Atomic; no window. Always preferred when
//      available.
//   2. A CHILD PROCESS binds it -> either a fixed port below 32768 reserved in
//      the registry above (best: no window at all, but the number must be
//      unique repo-wide), or `allocateAnvilPort()` when a fixed reservation is
//      impractical -- many ports, or several instances inside one file. The
//      allocator has a narrow allocate-then-rebind window; the reservation has
//      none.
//   3. The assertion IS "nothing is listening here" -> a fixed port below
//      32768, with a comment saying why.
//
// The invariant under all three: never a literal inside 32768-65535 in a
// port-shaped position -- a `.listen(` argument, a port-shaped object key, or a
// port-ish `const`. A port buried in a URL string is outside what the lint can
// see; see the "does NOT catch" list in
// operator/scripts/check-no-fixed-test-port.mjs.
//
// This scenario is case 2 with a fixed reservation: it spawns one real daemon,
// one port, for the lifetime of the file. See issue #1627 and
// docs/runbooks/testing.md, "Worker parallelism and ports".
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
  return runScenario('T1.2', opts, async ({ log }) => {
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
      return { verdict: 'pass' };
    } finally {
      if (daemons) {
        try { await daemons.teardown(); } catch { /* best-effort */ }
      }
      if (tmpHome) {
        try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  });
}

