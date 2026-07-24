import { describe, it, expect } from 'vitest';
import { allocateAnvilPort } from '@test/chain/port-allocator.js';
import { createServer } from 'node:net';

describe('allocateAnvilPort', () => {
  it('returns a listenable port', async () => {
    const port = await allocateAnvilPort();
    expect(port).toBeGreaterThan(1024);
    await new Promise<void>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
    });
  });
});
