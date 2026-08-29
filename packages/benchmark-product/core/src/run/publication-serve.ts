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
  /**
   * Receives a post-listen server error. The listener exists so a late `EMFILE` cannot become an
   * uncaught exception in a process whose whole job is to stay up unattended; this is how that
   * silence is broken for the operator watching it.
   */
  readonly onError?: (cause: unknown) => void;
}

export type PublicationWellKnownOutcome = "published" | "not-announced" | "refresh-failed";

export interface PublicationArchiveServer {
  readonly host: string;
  readonly port: number;
  /** Origin the archive is mounted at, with no trailing slash. */
  readonly url: string;
  /**
   * What the start-time well-known refresh did. `refresh-failed` is kept distinct from
   * `not-announced` because they call for opposite operator responses: nothing to publish yet,
   * versus a document on disk that may now name a superseded archive page. Either way the server
   * still serves -- the signed chain is on disk, and refusing to serve it over a derived document
   * would be the wrong trade -- but only one of the two is a problem.
   */
  readonly wellKnown: PublicationWellKnownOutcome;
  /** The refresh failure, present only when `wellKnown` is `refresh-failed`. */
  readonly refreshFailure?: unknown;
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
  // Read the body BEFORE committing the status line: once headers are sent, a body that fails to
  // materialize can only be signalled by destroying the connection, and a client that saw 200 has
  // no way to tell a short body from a complete one.
  const body = method === "HEAD" || produced.body === null ? undefined : Buffer.from(await produced.arrayBuffer());
  const headers: Record<string, string> = {};
  produced.headers.forEach((value, name) => { headers[name] = value; });
  response.writeHead(produced.status, headers);
  response.end(body);
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

  // A serve that cannot refresh the derived document still serves the signed chain: the common
  // cause is another product process holding the source lock mid-announce, whose acquire times
  // out and throws rather than waiting forever. Refusing to serve a readable tree over that would
  // be the wrong trade -- but reporting it as "nothing announced yet" would be a false statement
  // about a source that has announced, so the failure is carried out separately.
  let wellKnown: PublicationWellKnownOutcome;
  let refreshFailure: unknown;
  try {
    wellKnown = await refreshWorkspacePublicationWellKnown(options.workspaceDir, options.sourceName)
      ? "published"
      : "not-announced";
  } catch (cause) {
    wellKnown = "refresh-failed";
    refreshFailure = cause;
  }
  const handler = createWorkspacePublicationHttpHandler(options.workspaceDir);

  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    void (async () => {
      try {
        await respond(response, await handler(new Request(requestUrl(request), { method, headers: requestHeaders(request) })), method);
      } catch {
        // Indistinguishable from absence, exactly as the handler's own confinement failures are --
        // unless the status line is already out, in which case a truncated body must not be
        // presentable as a complete one.
        if (response.headersSent) { response.destroy(); return; }
        // The fallback itself is guarded: an escaping throw here would surface as an unhandled
        // rejection out of this detached async call and take the process down.
        try { response.writeHead(404); response.end(); } catch { response.destroy(); }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.removeListener("error", reject); resolve(); });
  });
  // A listening server with no `error` listener turns any later emission into an uncaught
  // exception, which would kill a process whose whole job is to stay up unattended. Reported
  // rather than swallowed: resource exhaustion that nobody is told about looks exactly like a
  // healthy idle server.
  server.on("error", (cause) => options.onError?.(cause));

  const address = server.address() as AddressInfo;
  const authority = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    host: address.address,
    port: address.port,
    url: `http://${authority}:${address.port}`,
    wellKnown,
    ...(wellKnown === "refresh-failed" ? { refreshFailure } : {}),
    close: () => new Promise<void>((resolve, reject) => {
      // Idempotent: a second close is the caller's `finally` running after an explicit stop, not
      // an error worth rejecting on.
      if (!server.listening) { resolve(); return; }
      server.close((cause) => (cause === undefined ? resolve() : reject(cause)));
      server.closeAllConnections();
    }),
  };
}
