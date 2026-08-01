import { describe, it, expect } from 'vitest';
import { EvaluatorLoop } from '../../src/daemon/evaluator-loop.js';
import { evaluatorLoopHarness } from '../_support/evaluation-fixtures.js';

describe('EvaluatorLoop', () => {
  it('runs one opportunity end to end: open verdict attempt, execute, deliver, claim', async () => {
    const harness = await evaluatorLoopHarness();
    const loop = new EvaluatorLoop(harness.config);
    const running = loop.run();
    harness.emitOpportunity();
    await harness.settled();
    loop.stop();
    await running;

    expect(harness.venue.verdict.openVerdictAttempt).toHaveBeenCalledTimes(1);
    expect(harness.backend.submit).toHaveBeenCalledTimes(1);
    expect(harness.venue.verdict.claimVerdictDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ verdictCode: 2 }), // Fail — from the delivered Statement, not a default
    );
  });

  it('never opens a verdict attempt for the operator\'s own solution', async () => {
    const harness = await evaluatorLoopHarness();
    const loop = new EvaluatorLoop(harness.config);
    const running = loop.run();
    harness.emitOwnSolutionOpportunity();
    await harness.idle();
    loop.stop();
    await running;
    expect(harness.venue.verdict.openVerdictAttempt).not.toHaveBeenCalled();
    expect(harness.backend.submit).not.toHaveBeenCalled();
  });

  it('skips a private-specification opportunity with a named reason and no chain write', async () => {
    const harness = await evaluatorLoopHarness({ spec: 'private' });
    const loop = new EvaluatorLoop(harness.config);
    const running = loop.run();
    harness.emitOpportunity();
    await harness.idle();
    loop.stop();
    await running;
    expect(harness.venue.verdict.openVerdictAttempt).not.toHaveBeenCalled();
    expect(harness.skips).toContainEqual(expect.objectContaining({ kind: 'private-specification' }));
  });

  it('writes the engagement-ledger row before the verdict broadcast', async () => {
    const harness = await evaluatorLoopHarness();
    const loop = new EvaluatorLoop(harness.config);
    const running = loop.run();
    harness.emitOpportunity();
    await harness.settled();
    loop.stop();
    await running;
    expect(harness.order.indexOf('ledger')).toBeLessThan(harness.order.indexOf('open-verdict'));
  });

  it('drain finishes the in-flight evaluation and accepts no new opportunity', async () => {
    const harness = await evaluatorLoopHarness();
    const loop = new EvaluatorLoop(harness.config);
    const running = loop.run();
    harness.emitOpportunity();
    const draining = loop.drain();
    harness.emitOpportunity();
    await draining;
    loop.stop();
    await running;
    expect(harness.venue.verdict.openVerdictAttempt).toHaveBeenCalledTimes(1);
  });
});
