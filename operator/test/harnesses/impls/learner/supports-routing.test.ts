/**
 * C6 — `LearnerHarness.supports()` stops defaulting to every SolverType
 * (product design §10, "Learner migration").
 *
 * Two flag states, both pinned here:
 *   - explicit routing (the new default): only the configured allowlist is
 *     claimed; an unconfigured learner claims nothing.
 *   - legacy default routing (the compatibility flag): the shipped
 *     wrap-everything-except-two-prediction-types behaviour, byte-for-byte.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LearnerHarness } from '../../../../src/harnesses/impls/learner/harness.js';
import { NoOpHarnessAdapter } from '../../../../src/harnesses/impls/learner/test-utils/noop-adapter.js';
import { LEGACY_DEFAULT_ROUTING_ENV } from '../../../../src/harnesses/impls/learner/routing.js';

const ORIGINAL_ENV = process.env[LEGACY_DEFAULT_ROUTING_ENV];

function harness(config: Partial<ConstructorParameters<typeof LearnerHarness>[0]> = {}) {
  return new LearnerHarness({ adapter: new NoOpHarnessAdapter(), pluginRoot: '/tmp/plugin-root', ...config });
}

beforeEach(() => {
  delete process.env[LEGACY_DEFAULT_ROUTING_ENV];
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[LEGACY_DEFAULT_ROUTING_ENV];
  else process.env[LEGACY_DEFAULT_ROUTING_ENV] = ORIGINAL_ENV;
});

describe('LearnerHarness.supports() — explicit routing (new default)', () => {
  it('claims a SolverType named in the configured allowlist', () => {
    const impl = harness({ routing: { solverTypes: ['swe-rebench-v2.v1'] } });
    expect(impl.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(true);
  });

  it('refuses a SolverType absent from the configured allowlist', () => {
    const impl = harness({ routing: { solverTypes: ['swe-rebench-v2.v1'] } });
    expect(impl.supports({ solverType: 'portfolio.v0', role: 'restoration' })).toBe(false);
  });

  it('refuses everything when no allowlist is configured — no wrap-every-SolverType default', () => {
    const impl = harness();
    expect(impl.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(false);
    expect(impl.supports({ solverType: 'portfolio.v0', role: 'restoration' })).toBe(false);
    expect(impl.supports({ solverType: 'anything.at.all', role: 'restoration' })).toBe(false);
  });

  it('refuses an empty allowlist (explicitly configured to claim nothing)', () => {
    const impl = harness({ routing: { solverTypes: [] } });
    expect(impl.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(false);
  });

  it('refuses evaluation regardless of the allowlist — the role gate outranks routing', () => {
    const impl = harness({ routing: { solverTypes: ['swe-rebench-v2.v1'] } });
    expect(impl.supports({ solverType: 'swe-rebench-v2.v1', role: 'evaluation' })).toBe(false);
  });

  it('never claims the two specialist prediction SolverTypes, even if an operator allowlists them', () => {
    // The blocklist is a packaging constraint (the learner emits phase artifacts,
    // not the typed solutionPayload these SolverTypes require), not a routing
    // preference — so an allowlist entry must not override it.
    const impl = harness({ routing: { solverTypes: ['prediction.v1', 'prediction.apy.v0'] } });
    expect(impl.supports({ solverType: 'prediction.v1', role: 'restoration' })).toBe(false);
    expect(impl.supports({ solverType: 'prediction.apy.v0', role: 'restoration' })).toBe(false);
  });
});

describe('LearnerHarness.supports() — legacy default routing (compatibility flag)', () => {
  it('claims every non-evaluation SolverType when the flag is set via config', () => {
    const impl = harness({ routing: { legacyDefaultRouting: true } });
    expect(impl.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(true);
    expect(impl.supports({ solverType: 'portfolio.v0', role: 'restoration' })).toBe(true);
    expect(impl.supports({ solverType: 'never.heard.of.it', role: 'restoration' })).toBe(true);
  });

  it('claims every non-evaluation SolverType when the flag is set via the environment', () => {
    process.env[LEGACY_DEFAULT_ROUTING_ENV] = '1';
    const impl = harness();
    expect(impl.supports({ solverType: 'never.heard.of.it', role: 'restoration' })).toBe(true);
  });

  it('preserves the shipped two-item blocklist under the flag', () => {
    const impl = harness({ routing: { legacyDefaultRouting: true } });
    expect(impl.supports({ solverType: 'prediction.v1', role: 'restoration' })).toBe(false);
    expect(impl.supports({ solverType: 'prediction.apy.v0', role: 'restoration' })).toBe(false);
  });

  it('still refuses evaluation under the flag', () => {
    const impl = harness({ routing: { legacyDefaultRouting: true } });
    expect(impl.supports({ solverType: 'swe-rebench-v2.v1', role: 'evaluation' })).toBe(false);
  });

  it('treats an explicit config `false` as authoritative over the environment flag', () => {
    process.env[LEGACY_DEFAULT_ROUTING_ENV] = '1';
    const impl = harness({ routing: { legacyDefaultRouting: false, solverTypes: ['portfolio.v0'] } });
    expect(impl.supports({ solverType: 'portfolio.v0', role: 'restoration' })).toBe(true);
    expect(impl.supports({ solverType: 'never.heard.of.it', role: 'restoration' })).toBe(false);
  });
});
