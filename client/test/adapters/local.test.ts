import { describe, it, expect, beforeEach } from 'vitest';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import type { RestorationJob, RestorationRequest } from '../../src/types/index.js';

describe('LocalAdapter', () => {
  let adapter: LocalAdapter;

  beforeEach(async () => {
    adapter = new LocalAdapter();
    await adapter.initialize();
  });

  it('posts a desired state and makes restoration request available immediately', async () => {
    const state: RestorationJob = { id: 'ds-1', description: 'Test state' };
    const requestId = await adapter.postRestorationJob(state);
    expect(requestId).toBeDefined();

    const requests: RestorationRequest[] = [];
    for await (const req of adapter.watchForRequests()) {
      requests.push(req);
      break; // take one — should be the restoration request
    }
    expect(requests).toHaveLength(1);
    expect(requests[0].restorationJob.type).toBe('restoration');
  });

  it('claim always succeeds', async () => {
    const state: RestorationJob = { id: 'ds-1', description: 'Test state' };
    const requestId = await adapter.postRestorationJob(state);
    await expect(adapter.claimRequest(requestId)).resolves.toBeUndefined();
  });

  it('submit makes result available as delivery', async () => {
    const state: RestorationJob = { id: 'ds-1', description: 'Test state' };
    const requestId = await adapter.postRestorationJob(state);
    await adapter.claimRequest(requestId);
    await adapter.submitResult(requestId, { data: 'restored' });

    const deliveries: unknown[] = [];
    for await (const delivery of adapter.watchForDeliveries()) {
      deliveries.push(delivery);
      break;
    }
    expect(deliveries).toHaveLength(1);
  });

  it('creates both restoration and evaluation requests when posting', async () => {
    const state: RestorationJob = { id: 'ds-1', description: 'Test state' };
    const restorationRequestId = await adapter.postRestorationJob(state);

    // First request yielded should be the restoration request
    const iter = adapter.watchForRequests()[Symbol.asyncIterator]();
    const { value: restorationReq } = await iter.next();
    expect(restorationReq.restorationJob.type).toBe('restoration');
    expect(restorationReq.requestId).toBe(restorationRequestId);

    // Deliver the restoration so the evaluation request becomes available
    await adapter.submitResult(restorationRequestId, { data: 'done' });

    // Now the evaluation request should be yielded
    const { value: evalReq } = await iter.next();
    expect(evalReq.restorationJob.type).toBe('evaluation');
    expect(evalReq.restorationJob.restorationRequestId).toBe(restorationRequestId);

    await adapter.stop();
  });

  it('evaluation request is only yielded after restoration is delivered', async () => {
    const state: RestorationJob = { id: 'ds-1', description: 'Test state' };
    const restorationRequestId = await adapter.postRestorationJob(state);

    const iter = adapter.watchForRequests()[Symbol.asyncIterator]();

    // Get the restoration request
    const { value: restorationReq } = await iter.next();
    expect(restorationReq.restorationJob.type).toBe('restoration');

    // Before delivery, evaluation request should not be available
    // We check by racing with a short timeout
    const raceResult = await Promise.race([
      iter.next().then(() => 'got-request'),
      new Promise<string>(r => setTimeout(() => r('timeout'), 50)),
    ]);
    expect(raceResult).toBe('timeout');

    // Now deliver the restoration
    await adapter.submitResult(restorationRequestId, { data: 'done' });

    // The evaluation request should now be yielded (the pending iter.next() resolves)
    // Give it a moment for the deferred check to run
    await new Promise(r => setTimeout(r, 10));

    await adapter.stop();
  });
});
