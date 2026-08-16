import { createServer } from 'node:net';

/**
 * Asks the OS kernel for a free TCP port by binding to :0 and reading the
 * assigned port. Caller must spawn its process promptly — the port is
 * re-usable immediately but a racing allocator could pick it.
 * Replaces the hand-coded 8546/8547/8548/8549 ports in legacy e2e scripts.
 */
export function allocateAnvilPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('could not resolve allocated port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}
