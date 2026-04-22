import { createServer } from 'node:net';

export interface ApiPortPreflightOk {
  ok: true;
  port: number;
}

export interface ApiPortPreflightFail {
  ok: false;
  port: number;
  code?: string;
  message: string;
}

export type ApiPortPreflightResult = ApiPortPreflightOk | ApiPortPreflightFail;

export async function checkApiPortAvailable(port: number): Promise<ApiPortPreflightResult> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;

    const finish = (result: ApiPortPreflightResult) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      resolve(result);
    };

    server.once('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        port,
        code: error.code,
        message: error.message,
      });
    });

    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      server.close(() => finish({ ok: true, port }));
    });
  });
}

export function apiPortFailureMessage(result: ApiPortPreflightFail): string {
  if (result.code === 'EADDRINUSE') {
    return `Port ${result.port} is already in use. Stop the other daemon or set JINN_API_PORT / apiPort to another port.`;
  }
  return `Port ${result.port} is not available: ${result.message}`;
}
