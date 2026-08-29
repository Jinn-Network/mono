/**
 * Public serving of this workspace's Record Discovery source.
 *
 * `createWorkspacePublicationHttpHandler` (publication-source.ts) already answers the archive
 * grammar; what did not exist was any way to put it on a socket. This module is that composition:
 * a headless `node:http` listener over the same handler, with no product UI, no workspace
 * selection, and no write route -- the served tree is append-only and digest-addressed, so
 * everything below is read-only by construction.
 *
 * Serving is deliberately not the only supported deployment. The layout is plain immutable files,
 * so an operator may equally publish `<workspace>/publication/public/` from any static host or
 * object store; `docs/runbooks/colophon-announcement-source-serving.md` covers both, and ends at
 * the host/domain provisioning step this product does not perform.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createWorkspacePublicationHttpHandler,
  refreshWorkspacePublicationWellKnown,
} from "./publication-source.js";

/** Loopback by default: a public deployment is an explicit act, never a side effect of serving. */
export const DEFAULT_PUBLICATION_SERVE_HOST = "127.0.0.1";
export const DEFAULT_PUBLICATION_SERVE_PORT = 8787;

export interface PublicationArchiveServerOptions {
  readonly workspaceDir: string;
  /** The source whose well-known document is refreshed at start. */
  readonly sourceName: string;
  /** Defaults to loopback. Pass `0.0.0.0` only behind a reverse proxy you control. */
  readonly host?: string;
  /** `0` binds an ephemeral port; the bound port is reported back on the result. */
  readonly port?: number;
}

export interface PublicationArchiveServer {
  readonly host: string;
  readonly port: number;
  /** Origin the archive is mounted at, with no trailing slash. */
  readonly url: string;
  /** Whether a well-known document was published; `false` when the source has never announced. */
  readonly announced: boolean;
  close(): Promise<void>;
}

function requestHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) {
      try { headers.append(name, single); } catch { /* a malformed header is dropped, never fatal */ }
    }
  }
  return headers;
}

function requestUrl(message: IncomingMessage): string {
  // Only the path is consulted downstream -- the handler's grammar is origin-independent -- so a
  // fixed placeholder origin is used rather than a client-supplied `Host` header.
  return new URL(message.url ?? "/", "http://publication.invalid").toString();
}

async function respond(response: ServerResponse, produced: Response, method: string): Promise<void> {
  const headers: Record<string, string> = {};
  produced.headers.forEach((value, name) => { headers[name] = value; });
  response.writeHead(produced.status, headers);
  if (method === "HEAD" || produced.body === null) { response.end(); return; }
  response.end(Buffer.from(await produced.arrayBuffer()));
}

/**
 * Binds the workspace's public archive to a socket and returns once it is listening.
 *
 * The well-known document is refreshed first: a workspace whose announcements predate this
 * serving path has a valid signed chain on disk but nothing telling a cold client where the
 * newest archive page is.
 */
export async function startPublicationArchiveServer(
  options: PublicationArchiveServerOptions,
): Promise<PublicationArchiveServer> {
  const host = options.host ?? DEFAULT_PUBLICATION_SERVE_HOST;
  const port = options.port ?? DEFAULT_PUBLICATION_SERVE_PORT;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new TypeError("port must be an integer from 0 to 65535");

  const announced = await refreshWorkspacePublicationWellKnown(options.workspaceDir, options.sourceName);
  const handler = createWorkspacePublicationHttpHandler(options.workspaceDir);

  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    void (async () => {
      try {
        await respond(response, await handler(new Request(requestUrl(request), { method, headers: requestHeaders(request) })), method);
      } catch {
        // Indistinguishable from absence, exactly as the handler's own confinement failures are.
        if (!response.headersSent) response.writeHead(404);
        response.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.removeListener("error", reject); resolve(); });
  });

  const address = server.address() as AddressInfo;
  const authority = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    host: address.address,
    port: address.port,
    url: `http://${authority}:${address.port}`,
    announced,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((cause) => (cause === undefined ? resolve() : reject(cause)));
      server.closeAllConnections();
    }),
  };
}
