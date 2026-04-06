import { describe, it, expect } from 'vitest';
import { withTestEnv } from '../helpers/env-controller.js';
import { withTenderlyVNet } from '../helpers/tenderly-runner.js';
import { withProcessHarness } from '../helpers/process-harness.js';
import { withSuiteEnv } from '../helpers/suite-env.js';

describe('process harness smoke', () => {
  it('spins up ponder/control stack', async () => {
    await withSuiteEnv(async () => {
      await withTestEnv(async () => {
        await withTenderlyVNet(async (tenderlyCtx) => {
          await withProcessHarness(
            { rpcUrl: tenderlyCtx.rpcUrl, startWorker: false },
            async (ctx) => {
              expect(ctx.gqlUrl).toMatch(/http:\/\/127.0.0.1/);
              expect(ctx.controlUrl).toMatch(/http:\/\/127.0.0.1/);
            }
          );
        });
      });
    });
  }, 240_000);
});
