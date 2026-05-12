/**
 * Hono middleware that adds HTTP freshness semantics to /explorer/* responses.
 *
 * Exports only `withFreshness`. A DB-query helper (`getIndexedHead`) is
 * intentionally omitted from this file: the route handlers in the /explorer/*
 * files have access to the Ponder `db` object and can compute the head
 * themselves, then pass `() => ({ lastIndexedBlock, lastIndexedAt })` to
 * `withFreshness`. Keeping DB I/O out of this module also keeps it testable
 * without a Ponder/Drizzle context.
 *
 * Cache policy:
 *   Cache-Control: public, max-age=30, stale-while-revalidate=60
 *   ETag: W/"<lastIndexedBlock>"
 *
 * The ETag is a weak validator on the last indexed block — a change to the
 * indexed head always produces a new ETag, so clients that re-validate with
 * If-None-Match get a 304 hit when the index hasn't advanced.
 */
import type { MiddlewareHandler } from 'hono';

/** Indexer freshness metadata provided by the route handler's query. */
export interface FreshnessMeta {
  /** The most recently indexed block number. */
  lastIndexedBlock: bigint;
  /** ISO 8601 timestamp of when that block was indexed. */
  lastIndexedAt: string;
}

/**
 * Hono middleware factory that adds ETag / Cache-Control HTTP-cache semantics.
 *
 * Pass a synchronous or async function that returns {@link FreshnessMeta}
 * derived from the same query the route handler runs. The middleware:
 *
 * 1. Computes `ETag: W/"<lastIndexedBlock>"`.
 * 2. If the request's `If-None-Match` header equals the current ETag,
 *    responds with `304 Not Modified` and an empty body (short-circuit).
 * 3. Otherwise, calls `next()` and then sets `ETag` and `Cache-Control` on
 *    the response that the downstream handler produced.
 *
 * @example
 * ```ts
 * app.use('/explorer/*', withFreshness(async () => {
 *   const row = await db.select(...).from(someTable).limit(1);
 *   return { lastIndexedBlock: row.block, lastIndexedAt: row.indexedAt };
 * }));
 * ```
 */
export function withFreshness(
  getMeta: () => FreshnessMeta | Promise<FreshnessMeta>,
): MiddlewareHandler {
  return async (c, next) => {
    const meta = await getMeta();
    const etag = `W/"${meta.lastIndexedBlock}"`;

    // Short-circuit with 304 if the client's cached copy is still current.
    if (c.req.header('If-None-Match') === etag) {
      c.header('ETag', etag);
      return c.newResponse(null, 304);
    }

    await next();

    // Set caching headers on the downstream response.
    c.header('ETag', etag);
    c.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  };
}
