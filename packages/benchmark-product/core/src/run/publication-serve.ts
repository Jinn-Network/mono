/**
 * Public serving of this workspace's Record Discovery source.
 *
 * `createWorkspacePublicationHttpHandler` (publication-source.ts) already answers the archive
 * grammar and `/lock-index.json`; what did not exist was any way to put it on a socket. This
 * module is that composition: a headless `node:http` listener over the same handler, with no
 * product UI, no workspace selection, and no write route -- the served tree is append-only and
 * digest-addressed, so every request is answered read-only by construction. The one thing the
 * process itself writes is the source head, re-signed at its current position while it serves so
 * an idle source's head does not lapse (#4187).
 *
 * Serving is deliberately not the only supported deployment. The layout is plain immutable files,
 * so an operator may equally publish `<workspace>/publication/public/` from any static host or
 * object store; `docs/runbooks/colophon-announcement-source-serving.md` covers both, and ends at
 * the host/domain provisioning step this product does not perform.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { assertWorkspace } from "../workspace/workspace.js";
import {
  createWorkspacePublicationHttpHandler,
  refreshWorkspacePublicationHead,
  refreshWorkspacePublicationWellKnown,
  type WorkspacePublicationHeadRefresh,
} from "./publication-source.js";
import { refreshWorkspacePublicationLockIndex } from "./publication-lock-index.js";

/** Loopback by default: a public deployment is an explicit act, never a side effect of serving. */
export const DEFAULT_PUBLICATION_SERVE_HOST = "127.0.0.1";
export const DEFAULT_PUBLICATION_SERVE_PORT = 8787;
/**
 * How often a serving process checks whether the source head is due for a re-sign (#4187). The
 * check is cheap and level-triggered, so a short tick only shortens the delay before a due head
 * is re-signed; the head itself is re-signed about once per half window, every 12 hours today.
 */
export const DEFAULT_PUBLICATION_HEAD_REFRESH_INTERVAL_MS = 300_000;
/** `setInterval` coerces anything longer to a 1ms period. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
  /**
   * Receives human-readable progress lines emitted before the server is returned. The start-time
   * refreshes take the source lock, whose acquire waits out a 30-second timeout when another
   * product process is mid-announce; without a line the operator's first output is `serving ...`
   * long after they expected a socket, with nothing to distinguish the wait from a hang.
   */
  readonly onProgress?: (line: string) => void;
  /**
   * How often, while the server listens, the source head is checked and re-signed once no more
   * than half of its freshness window remains (#4187). A head is otherwise signed only when something
   * is announced, so an idle source's head lapses `refreshBy` a day later and every cold reader
   * refuses it. Defaults to `DEFAULT_PUBLICATION_HEAD_REFRESH_INTERVAL_MS`; `0` turns the
   * heartbeat off.
   */
  readonly headRefreshIntervalMs?: number;
  /**
   * Receives each heartbeat outcome that differs from the one before it, starting with the check
   * made once the server is listening. Called on a change rather than on every tick, so an
   * outcome that keeps the head from being re-signed is reported when it starts, without
   * repeating on every tick.
   */
  readonly onHeadRefresh?: (outcome: WorkspacePublicationHeadRefresh) => void;
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
  /** The heartbeat check made once the server was listening; absent when the heartbeat is off. */
  readonly headRefresh?: WorkspacePublicationHeadRefresh;
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
 * newest archive page is. The lock index is regenerated next, so it names anchors and bundles
 * recorded since the last registration, and is served at its fixed path beside the archive.
 * Once the socket is bound, the source head is re-signed if it is due, and again on every
 * heartbeat tick that finds it due while the server listens.
 */
export async function startPublicationArchiveServer(
  options: PublicationArchiveServerOptions,
): Promise<PublicationArchiveServer> {
  const progress = (line: string): void => {
    // A diagnostic sink that throws must not fail the serve it was only describing.
    try { options.onProgress?.(line); } catch { /* nothing to report to */ }
  };
  // First, and before anything that touches the directory. `createWorkspacePublicationSource`
  // reaches `loadOrCreateReportSigningKey`, which is load-OR-CREATE: without this a mistyped or
  // stale `--workspace` minted a fresh signing identity and a serving root at the wrong path,
  // then bound a socket over an empty archive and exited 0 -- a typo indistinguishable from
  // success. Every other publication verb already refuses first, because it needs a draft.
  assertWorkspace(options.workspaceDir);
  const host = options.host ?? DEFAULT_PUBLICATION_SERVE_HOST;
  const port = options.port ?? DEFAULT_PUBLICATION_SERVE_PORT;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new TypeError("port must be an integer from 0 to 65535");
  const headRefreshIntervalMs = options.headRefreshIntervalMs ?? DEFAULT_PUBLICATION_HEAD_REFRESH_INTERVAL_MS;
  if (!Number.isSafeInteger(headRefreshIntervalMs) || headRefreshIntervalMs < 0 || headRefreshIntervalMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`headRefreshIntervalMs must be an integer from 0 to ${MAX_TIMER_DELAY_MS}`);
  }

  // A serve that cannot refresh the derived document still serves the signed chain: the common
  // cause is another product process holding the source lock mid-announce, whose acquire times
  // out and throws rather than waiting forever. Refusing to serve a readable tree over that would
  // be the wrong trade -- but reporting it as "nothing announced yet" would be a false statement
  // about a source that has announced, so the failure is carried out separately.
  let wellKnown: PublicationWellKnownOutcome;
  let refreshFailure: unknown;
  progress(`refreshing the well-known document for source ${options.sourceName}`);
  try {
    wellKnown = await refreshWorkspacePublicationWellKnown(
      options.workspaceDir,
      options.sourceName,
      // The expected cause of a long wait, and the one that resolves on its own -- said plainly
      // so the operator neither kills the process nor mistakes the wait for a hang.
      () => progress("waiting on the publication source lock (another process is mid-announce); this clears on its own"),
    )
      ? "published"
      : "not-announced";
  } catch (cause) {
    wellKnown = "refresh-failed";
    refreshFailure = cause;
  }
  // The lock index is derived presentation (publication-lock-index.ts), so a failure to rebuild it
  // never blocks serving; any earlier index stays in place and still links only immutable bytes.
  try {
    await refreshWorkspacePublicationLockIndex(
      options.workspaceDir,
      () => progress("waiting on the publication source lock (another process is mid-announce); this clears on its own"),
    );
  } catch (cause) {
    progress(`the lock index was not refreshed (${cause instanceof Error ? cause.message : String(cause)}); any earlier index is served unchanged`);
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
  // The callback is guarded for the same reason the listener exists at all: a diagnostic sink
  // that throws -- `process.stderr.write` raising EPIPE once the reader is gone, say -- must not
  // become the uncaught exception this listener was added to prevent.
  server.on("error", (cause) => { try { options.onError?.(cause); } catch { /* a sink that cannot report is not a reason to die */ } });

  // The idle-head heartbeat (#4187). It runs only while this process serves: a process that has
  // stopped re-signs nothing, so its head lapses on schedule and readers refuse it, which is the
  // withholding signal `refreshBy` exists to give. Taken after the bind for the same reason.
  let lastHeadRefresh: WorkspacePublicationHeadRefresh["status"] | undefined;
  const beat = async (onContended?: () => void): Promise<WorkspacePublicationHeadRefresh> => {
    const outcome = await refreshWorkspacePublicationHead(options.workspaceDir, options.sourceName, onContended);
    if (outcome.status !== lastHeadRefresh) {
      lastHeadRefresh = outcome.status;
      // A sink that throws must not stop the heartbeat it is only describing.
      try { options.onHeadRefresh?.(outcome); } catch { /* nothing to report to */ }
    }
    return outcome;
  };
  let headRefresh: WorkspacePublicationHeadRefresh | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let beating: Promise<unknown> | undefined;
  if (headRefreshIntervalMs > 0) {
    headRefresh = await beat(() => progress("waiting on the publication source lock (another process is mid-announce); this clears on its own"));
    heartbeat = setInterval(() => {
      // Level-triggered, so a tick skipped behind a slow one loses nothing.
      if (beating !== undefined) return;
      beating = beat().finally(() => { beating = undefined; });
    }, headRefreshIntervalMs);
    heartbeat.unref();
  }

  const address = server.address() as AddressInfo;
  const authority = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    host: address.address,
    port: address.port,
    url: `http://${authority}:${address.port}`,
    wellKnown,
    ...(wellKnown === "refresh-failed" ? { refreshFailure } : {}),
    ...(headRefresh === undefined ? {} : { headRefresh }),
    close: async () => {
      clearInterval(heartbeat);
      // A beat in flight holds the source lock and may be writing the head; let it finish so
      // nothing is written after close resolves.
      await beating;
      await new Promise<void>((resolve, reject) => {
        // Idempotent: a second close is the caller's `finally` running after an explicit stop,
        // not an error worth rejecting on.
        if (!server.listening) { resolve(); return; }
        server.close((cause) => (cause === undefined ? resolve() : reject(cause)));
        server.closeAllConnections();
      });
    },
  };
}
