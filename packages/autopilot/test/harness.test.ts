import { describe, it, expect } from 'vitest';
import { pressureTest, type PressureCase } from '../src/pressure-test/harness.js';

const baseCase: PressureCase = {
  skill: 'superpowers:writing-plans',
  scenarioName: 'happy-path',
  scenario: 'Plan the widget.',
  deliverableCheck: () => true,
};

describe('pressureTest', () => {
  it('reports completed when the deliverable check passes', async () => {
    const result = await pressureTest(
      baseCase, '/tmp/x',
      async () => ({ exitCode: 0, stdout: 'done', stderr: '', timedOut: false }),
    );
    expect(result.verdict).toBe('completed');
    expect(result.skill).toBe('superpowers:writing-plans');
  });

  it('reports interactive-block when no deliverable and the run asked a question', async () => {
    const result = await pressureTest(
      { ...baseCase, deliverableCheck: () => false }, '/tmp/x',
      async () => ({ exitCode: 0, stdout: 'Which option do you want?', stderr: '', timedOut: false }),
    );
    expect(result.verdict).toBe('interactive-block');
  });

  it('passes the composed headless prompt to the runner', async () => {
    let seen = '';
    await pressureTest(baseCase, '/tmp/x', async (p) => {
      seen = p;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    });
    expect(seen).toMatch(/Headless mode/);
    expect(seen).toContain('Plan the widget.');
  });
});
