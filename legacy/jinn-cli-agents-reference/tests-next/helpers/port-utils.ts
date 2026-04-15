import net from 'node:net';

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => {
      server.close(() => resolve(false));
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port);
  });
}

export async function findAvailablePort(basePort = 4000, maxAttempts = 200): Promise<number> {
  // Try sequential ports first (faster)
  for (let i = 0; i < Math.min(maxAttempts, 50); i++) {
    const port = basePort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  
  // If sequential search failed, try wider range with larger gaps
  // This helps avoid port conflicts from stuck processes
  const startOffset = 50;
  for (let i = startOffset; i < maxAttempts; i++) {
    const port = basePort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  
  throw new Error(`Unable to find available port starting from ${basePort} after ${maxAttempts} attempts`);
}
