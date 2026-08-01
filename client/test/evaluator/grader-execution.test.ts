import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { graderExecutionProvisioner } from '../../src/evaluator/grader-execution.js';
import { deterministicProcessSpec, provisionInputFixture } from '../_support/evaluation-fixtures.js';

describe('grader-container execution (this stage is the execution owner)', () => {
  it('runs the grader container and writes evaluation-context.json into input/', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-grader-'));
    const containerRuntime = { run: vi.fn(async () => ({ exitCode: 0, stdout: '{"tests_passed":3}' })) };
    const provisioner = graderExecutionProvisioner({ containerRuntime })(
      provisionInputFixture({ root, spec: deterministicProcessSpec() }),
    );
    await provisioner.contract.setup(...provisionInputFixture.setupArgs({ root }));
    expect(containerRuntime.run).toHaveBeenCalledTimes(1);
    expect(existsSync(join(root, 'input/evaluation-context.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'input/evaluation-context.json'), 'utf8'))).toMatchObject({
      tests_passed: 3,
    });
  });

  it('does not run a container when the subject Results already carry the grader output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-grader-'));
    const containerRuntime = { run: vi.fn() };
    const provisioner = graderExecutionProvisioner({ containerRuntime })(
      provisionInputFixture({ root, spec: deterministicProcessSpec(), resultsCarryGraderOutput: true }),
    );
    await provisioner.contract.setup(...provisionInputFixture.setupArgs({ root }));
    expect(containerRuntime.run).not.toHaveBeenCalled();
  });

  it('fails the attempt as infrastructure when the container produces no parsable output — never invents a verdict', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-grader-'));
    const containerRuntime = { run: vi.fn(async () => ({ exitCode: 1, stdout: '' })) };
    const provisioner = graderExecutionProvisioner({ containerRuntime })(
      provisionInputFixture({ root, spec: deterministicProcessSpec() }),
    );
    await expect(provisioner.contract.setup(...provisionInputFixture.setupArgs({ root })))
      .rejects.toThrow(/grader container produced no output/);
    expect(existsSync(join(root, 'input/evaluation-context.json'))).toBe(false);
  });
});
