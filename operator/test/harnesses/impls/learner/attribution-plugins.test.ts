import { describe, it, expect } from 'vitest';
import { LearnerHarness } from '../../../../src/harnesses/impls/learner/index.js';
import type { HarnessAdapter, TaskSessionInputs } from '../../../../src/harnesses/impls/learner/types.js';

/** Minimal no-op adapter to satisfy the required `adapter` field. */
class NoOpAdapter implements HarnessAdapter {
  readonly name = 'noop';
  readonly allowsHarnessSelfModification = false;
  async runTask(_inputs: TaskSessionInputs, _pluginRoot: string): Promise<void> { /* no-op */ }
}

describe('LearnerHarness.attributionPlugins', () => {
  it('returns one descriptor for the claude-code-learner plugin', () => {
    const harness = new LearnerHarness({ adapter: new NoOpAdapter() });
    const plugins = harness.attributionPlugins();
    expect(plugins).toHaveLength(1);
    const [learner] = plugins;
    expect(learner.name).toBe('claude-code-learner');
    expect(learner.version).toMatch(/^\d+\.\d+\.\d+/); // whatever version ships
    expect(learner.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(learner.provenance).toBe('default');
    expect(learner.source).toBe('bundled:learner');
    expect(learner.root).toContain('plugins/learner');
  });

  it('carries the live manifest version (AC3 — observable, not bumped)', () => {
    const harness = new LearnerHarness({ adapter: new NoOpAdapter() });
    const [learner] = harness.attributionPlugins();
    // The descriptor reflects whatever version is in
    // operator/plugins/learner/.claude-plugin/plugin.json at build time.
    expect(typeof learner.version).toBe('string');
    expect(learner.version.length).toBeGreaterThan(0);
  });
});
