/**
 * Wave-4 D6 (DR-2026-08-05 addendum 2026-08-13, decision 3): `LOOP_REGISTRY`
 * drops exactly the five names D1–D4 deleted (`creator`, `engine-tick`,
 * `engine-watcher`, `delivery-watcher`, `peer-sync`). Remaining ten: the
 * earning five plus `posting` / `work` / `evaluator` / `projector` /
 * `evidence-driver`. Intervals and admission of the survivors are untouched.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOOP_NAMES, LOOP_REGISTRY } from '../../src/daemon/loop-heartbeat.js';
import { codeOnly } from './_support/source-text.js';

const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));

const FORBIDDEN = [
  'creator',
  'engine-tick',
  'engine-watcher',
  'delivery-watcher',
  'peer-sync',
] as const;

const REQUIRED = [
  'posting',
  'reward-claim',
  'balance-topup',
  'eviction-check',
  'checkpoint',
  'harvest',
  'projector',
  'evidence-driver',
  'work',
  'evaluator',
] as const;

const FORBIDDEN_TICK = /recordLoopTick\s*\([^)]*['"](?:creator|engine-tick|engine-watcher|delivery-watcher|peer-sync)['"]/u;

describe('LOOP_REGISTRY narrowed after D1–D4 (Wave-4 D6)', () => {
  it('the forbidden five are absent', () => {
    for (const name of FORBIDDEN) {
      expect(LOOP_NAMES).not.toContain(name);
    }
  });

  it('the earning five and posting/work/evaluator/projector/evidence-driver are present', () => {
    for (const name of REQUIRED) {
      expect(LOOP_NAMES).toContain(name);
    }
  });

  it('an empty registry cannot pass', () => {
    // Negative control: presence of the ten and absence of the five together
    // pin length. An emptied LOOP_REGISTRY would fail REQUIRED; a registry
    // that only dropped comments would fail FORBIDDEN.
    expect(LOOP_NAMES).toHaveLength(REQUIRED.length);
    expect(LOOP_REGISTRY).toHaveLength(REQUIRED.length);
    expect([...LOOP_NAMES].sort()).toEqual([...REQUIRED].sort());
  });

  it('adapter.ts does not recordLoopTick the forbidden names', () => {
    const adapter = codeOnly(readFileSync(join(srcRoot, 'adapters/mech/adapter.ts'), 'utf8'));
    expect(adapter).not.toMatch(FORBIDDEN_TICK);
  });

  it('the adapter tick scanner is non-vacuous', () => {
    expect(FORBIDDEN_TICK.test(codeOnly("recordLoopTick(store, 'engine-watcher');\n"))).toBe(true);
    expect(FORBIDDEN_TICK.test(codeOnly("recordLoopTick(store, 'checkpoint');\n"))).toBe(false);
    expect(FORBIDDEN_TICK.test(codeOnly("// recordLoopTick(store, 'engine-watcher');\nconst ready = true;\n"))).toBe(false);
  });
});
