import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { apiPortFailureMessage, checkApiPortAvailable } from '../../src/preflight/api-port.js';

describe('api port preflight', () => {
  it('reports an occupied port before daemon startup', async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, '0.0.0.0', () => resolve()));
    const addr = holder.address();
    if (!addr || typeof addr === 'string') throw new Error('missing address');
    try {
      const result = await checkApiPortAvailable(addr.port);
      expect(result).toMatchObject({ ok: false, port: addr.port, code: 'EADDRINUSE' });
      if (!result.ok) {
        expect(apiPortFailureMessage(result)).toContain(String(addr.port));
      }
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});
