/**
 * Wave-4 D1 (DR-2026-08-05, cutover stage-2 plan Task 16): the legacy TaskEngine,
 * its recovery entry point, and the `joinedSolverNets` claim gate retire together.
 *
 * Task 16 names `client/test/architecture/no-legacy-evaluation.test.ts` as the home
 * for these assertions; that file was a stage-2 Task-15 artifact that never landed on
 * `integration/evidence-v1`, so the pin lives here under its own name instead.
 *
 * `persistence.ts` (`TaskRunPersistence`) retired in Stage 5 PR 3 with
 * `legacy-task-run-store-coupling` → deleted.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_support/source-text.js';

const root = fileURLToPath(new URL('../../src/', import.meta.url));

function source(relative: string): string {
  return codeOnly(readFileSync(join(root, relative), 'utf8'));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === 'dist' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

describe('the legacy TaskEngine is retired', () => {
  it('has no TaskEngine', () => {
    expect(existsSync(join(root, 'harnesses/engine/engine.ts'))).toBe(false);
    expect(existsSync(join(root, 'harnesses/engine/recovery.ts'))).toBe(false);
  });

  it('has no retired engine-table persistence', () => {
    expect(existsSync(join(root, 'harnesses/engine/persistence.ts'))).toBe(false);
    expect(existsSync(join(root, 'store/task-run-persistence.ts'))).toBe(false);
  });

  it('starts no engine loops', () => {
    expect(source('daemon/daemon.ts')).not.toMatch(
      /TaskEngine|runTickLoop|_runEngineWatcherLoop|recoverInFlight/u,
    );
  });

  it('wires no restoration engine from the composition entry point', () => {
    expect(source('main.ts')).not.toMatch(/restorationEngine|createMutableJoinedSolverNetsView/u);
  });

  it('gates no claim on joinedSolverNets anywhere in src', () => {
    // What retires in D1 is the GATE and its live-mutation machinery, not the config
    // key: DR-2026-08-05 decision 7 / program contract 4 keep legacy config keys
    // parseable until stage 5, so read-only consumers of `config.joinedSolverNets`
    // (status rollups, launcher labels, spend-cap keying, `jinn eval` plug-in
    // resolution) survive this wave by design. These identifiers are the gate.
    const gateIdentifiers = [
      'evaluateJoinedEligibility',
      'JoinedSolverNetsView',
      'joinedSolverNetsViewFromConfig',
      'createMutableJoinedSolverNetsView',
      'createJoinApplier',
      'JoinApplier',
      'isReadyForClaim',
      'gateClaimByReadiness',
    ];
    const offenders = sourceFiles(root)
      .map((path) => path.slice(root.length))
      .filter((path) => {
        const text = codeOnly(readFileSync(join(root, path), 'utf8'));
        return gateIdentifiers.some((identifier) => text.includes(identifier));
      });
    expect(offenders).toEqual([]);
  });

  it('serves no join-lifecycle WRITE route, and no memberships read', () => {
    const setup = source('api/setup-endpoints.ts');
    expect(setup).not.toMatch(/'\/v1\/operator\/join\//u);
    expect(setup).not.toMatch(/app\.get\('\/v1\/operator\/joined'/u);
    expect(setup).not.toMatch(/app\.post\('\/v1\/setup\/solvernets\/:name'/u);
  });

  it('routes no join flow in the operator SPA', () => {
    expect(source('dashboard/spa/src/App.tsx')).not.toMatch(/JoinFlow|operator\/join\//u);
    expect(source('dashboard/spa/src/routes.ts')).not.toMatch(/operator\/join\//u);
    expect(existsSync(join(root, 'dashboard/spa/src/pages/operator-catalog/JoinFlow.tsx'))).toBe(false);
    expect(existsSync(join(root, 'dashboard/spa/src/pages/configuration/JoinedNetCard.tsx'))).toBe(false);
  });

  it('retires the memberships view', () => {
    expect(existsSync(join(root, 'dashboard/spa/src/pages/operator/MembershipsTab.tsx'))).toBe(false);
    const client = source('dashboard/spa/src/api/client.ts');
    expect(client).not.toMatch(/listJoined/u);
    expect(client).not.toMatch(/^\s{4}(join|leave):/mu);
    expect(source('dashboard/spa/src/App.tsx')).toMatch(/operator\/memberships.*Redirect to="\/operator\/claim-policy"/su);
  });

  it('collects no harness or model in the onboarding takeover', () => {
    // The picker's selection was persisted by re-joining; with the join route
    // gone it collected an answer and discarded it (PR #2655 review, B4).
    expect(existsSync(join(root, 'dashboard/spa/src/regions/onboarding/HarnessSelectStep.tsx'))).toBe(false);
    expect(source('dashboard/spa/src/regions/Onboarding.tsx')).not.toMatch(
      /HarnessSelection|harnessSel|completionReady/u,
    );
  });
});
