import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Server as HttpServer } from 'node:http';
import type { ArchiveHttpHandler } from '@jinn-network/record-discovery-transport-http';

/**
 * The public record-discovery archive plane (headless operator re-derivation design §6;
 * cutover stage 4 / one-swap M6).
 *
 * Exposure scoping (cross-plan contract 7) is STRUCTURAL, not middleware-based: this Hono app
 * carries exactly one thing — the archive handler — and nothing else. The handler admits only
 * the protocol serving paths (`parseArchivePath`: the well-known document, source heads,
 * archive pages, records by digest, the SSE tail) and returns a bare 404 for everything else.
 * The operator API app — which serves `/v1/status`, `/artifacts/*`, the SPA and its assets
 * without authentication — keeps its own listener bound to loopback and is NEVER widened to
 * publish the archive. That separation, not a per-route allowlist, is how "only the archive
 * subtree is public" is enforced and tested.
 *
 * Payload class: everything served here is `public` (archive records already sealed for
 * announcement); nothing `operator`-class is reachable.
 */
export interface PublicArchiveServer {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export function buildPublicArchiveApp(opts: { handler: ArchiveHttpHandler }): Hono {
  const app = new Hono();
  // One handler, no other route. The handler is the whole exposure surface.
  app.all('*', (c) => opts.handler(c.req.raw));
  return app;
}

export function startPublicArchiveServer(opts: {
  handler: ArchiveHttpHandler;
  host: string;
  port: number;
}): Promise<PublicArchiveServer> {
  const app = buildPublicArchiveApp({ handler: opts.handler });
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      // Plain speech where the operator's IP exposure is on the line (BRAND.md). Serving
      // publicly means anyone who fetches the archive learns this machine's IP address.
      console.warn(
        `[archive] Public record archive listening on ${opts.host}:${actualPort} — anyone who fetches it learns this machine's IP address. Publish the archive files to a mirror or static host instead if you would rather not disclose it.`,
      );
      resolve({
        host: opts.host,
        port: actualPort,
        close: () =>
          new Promise<void>((res, rej) =>
            (server as HttpServer).close((err) => (err ? rej(err) : res())),
          ),
      });
    });
    server.on('error', reject);
  });
}
