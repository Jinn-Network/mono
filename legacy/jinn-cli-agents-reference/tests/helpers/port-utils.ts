/**
 * Port allocation utilities for tests
 * Finds available ports to allow parallel test execution
 */

import net from 'node:net';

/**
 * Check if a port is available
 */
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port);
  });
}

/**
 * Find an available port starting from basePort
 * Increments port number until an available port is found
 *
 * @param basePort - The starting port to check (default: 42070)
 * @param maxAttempts - Maximum number of ports to try (default: 100)
 * @returns Available port number
 */
export async function findAvailablePort(basePort = 42070, maxAttempts = 100): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = basePort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`Could not find available port after ${maxAttempts} attempts starting from ${basePort}`);
}
