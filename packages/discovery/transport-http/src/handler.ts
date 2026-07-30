import { sha256Hex } from "@jinn-network/record-discovery-protocol";

import type { BlobReader } from "./ports.js";
import type { ArchiveTailSource } from "./tail.js";
import type { ArchiveRoute } from "./paths.js";
import { parseArchivePath, stripBasePath } from "./paths.js";

// The HTTP handler over `serve`'s static layout (spec §6.2), under the
// §7.3 wire profile:
//   - ETag / If-None-Match conditional GET on the head, the only mutable
//     object in the layout;
//   - `Cache-Control: immutable` on digest paths and on SEALED archive
//     pages (Finding F2: `serve`'s pager rewrites the newest page on
//     every append, so that one page gets ETag + no-cache instead);
//   - declared `Accept-Ranges: bytes` on blobs, with single-range GET
//     actually honored -- a declared range that 200s the whole body is a
//     lie to every mirror and CDN in the path.
//
// The handler is a plain Request-in/Response-out function so the host can
// mount it under one Hono route (`app.all(base + "/*", (c) => handler(c.req.raw))`)
// without this package depending on Hono. It routes ONLY what
// `parseArchivePath` admits (see paths.ts) -- cross-plan contract 7.

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const REVALIDATE_CACHE_CONTROL = "no-cache";

export type ArchiveHttpHandler = (request: Request) => Promise<Response>;

export interface ArchiveHttpHandlerOptions {
  /** The read side of the same store `serve` writes the layout into. */
  reader: BlobReader;
  /** Mount prefix stripped before grammar matching; "" (default) when mounted at the origin root. */
  basePath?: string;
  /** Live tail feed; absent means this deployment serves static files only and the tail path 404s. */
  tail?: ArchiveTailSource;
  /** Whether an archive page is sealed (a successor page exists) and may be marked immutable. Defaults to "no page is sealed". */
  isSealedPage?(sourceName: string, page: string): boolean;
}

/** Strong entity tag over the exact served bytes. */
export function computeEtag(bytes: Uint8Array): string {
  return `"sha256-${sha256Hex(bytes)}"`;
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

function parseSingleRange(header: string, length: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return undefined;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return "unsatisfiable";
    const start = Math.max(0, length - suffix);
    return { start, end: length - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? length - 1 : Number(rawEnd);
  if (start > end || start >= length) return "unsatisfiable";
  return { start, end: Math.min(end, length - 1) };
}

function cachePolicy(route: ArchiveRoute, options: ArchiveHttpHandlerOptions): string {
  if (route.kind === "record") return IMMUTABLE_CACHE_CONTROL;
  if (route.kind === "page") {
    const sealed = options.isSealedPage?.(route.sourceName, route.page) ?? false;
    return sealed ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
  }
  return REVALIDATE_CACHE_CONTROL;
}

export function createArchiveHttpHandler(options: ArchiveHttpHandlerOptions): ArchiveHttpHandler {
  const basePath = options.basePath ?? "";

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const relative = stripBasePath(url.pathname, basePath);
    if (relative === undefined) return notFound();

    const route = parseArchivePath(relative);
    if (route === undefined) return notFound();

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    }

    if (route.kind === "tail") {
      if (options.tail === undefined) return notFound();
      return openTailStream(request, route.sourceName, options.tail);
    }

    const object = await options.reader.get(route.path);
    if (object === undefined) return notFound();

    const etag = computeEtag(object.bytes);
    const headers = new Headers({
      "content-type": object.contentType,
      "cache-control": cachePolicy(route, options),
      etag,
    });
    if (route.kind === "record" || route.kind === "page") headers.set("accept-ranges", "bytes");

    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch !== null && ifNoneMatch.split(",").some((candidate) => candidate.trim() === etag)) {
      return new Response(null, { status: 304, headers });
    }

    const rangeHeader = request.headers.get("range");
    if (rangeHeader !== null && (route.kind === "record" || route.kind === "page")) {
      const range = parseSingleRange(rangeHeader, object.bytes.length);
      if (range === "unsatisfiable") {
        headers.set("content-range", `bytes */${object.bytes.length}`);
        return new Response(null, { status: 416, headers });
      }
      if (range !== undefined) {
        const slice = object.bytes.slice(range.start, range.end + 1);
        headers.set("content-range", `bytes ${range.start}-${range.end}/${object.bytes.length}`);
        headers.set("content-length", String(slice.length));
        return new Response(request.method === "HEAD" ? null : new Uint8Array(slice), { status: 206, headers });
      }
    }

    headers.set("content-length", String(object.bytes.length));
    return new Response(request.method === "HEAD" ? null : new Uint8Array(object.bytes), { status: 200, headers });
  };
}

// Wired in Task 8; declared here so the tail branch above compiles and
// so the "no tail source injected" behavior is fixed from this task on.
function openTailStream(_request: Request, _sourceName: string, _tail: ArchiveTailSource): Response {
  return notFound();
}
