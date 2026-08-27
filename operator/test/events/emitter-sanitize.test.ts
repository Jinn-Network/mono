import { afterEach, describe, expect, it } from 'vitest';
import { emitStructured, getEventBuffer } from '../../src/events/emitter.js';

const SECRET = 'SECRETKEY123';

describe('emitStructured persistence boundary (#642)', () => {
  afterEach(() => {
    getEventBuffer().clear();
  });

  it('sanitizes claim_failed nested error details and keeps the host', () => {
    emitStructured({
      kind: 'intent',
      message: 'Delivery claim failed',
      requestId: '0xabc',
      errorCode: 'claim_failed',
      details: {
        kind: 'restoration',
        source: 'mech.claimDelivery',
        error: `HTTP request failed. URL: https://user:${SECRET}@paid.example/v2/${SECRET}`,
      },
    });

    const event = getEventBuffer().snapshot().at(-1);
    expect(event?.errorCode).toBe('claim_failed');
    expect(event?.details?.error).toContain('paid.example');
    expect(JSON.stringify(event)).not.toContain(SECRET);
  });
});
