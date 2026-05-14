/**
 * Hono middleware that adds HTTP freshness semantics to /explorer/* responses.
 *
 * Exports only `withFreshness` and `FreshnessMeta`. A DB-query helper
 * (`getIndexedHead`) is intentionally omitted from this file: the route
 * handlers in the /explorer/* files have access to the Ponder `db` object and
 * can compute the head themselves, then pass the result to `withFreshness`.
 * Keeping DB I/O out of this module also keeps it testable without a
 * Ponder/Drizzle context.
 *
 * Cache policy:
 *   Cache-Control: public, max-age=30, stale-while-revalidate=60
 *   ETag: W/"<validator>"
 *
 * The ETag is a weak validator on the indexed data visible to the route. When
 * callers omit a custom validator, lastIndexedBlock is used for compatibility.
 */
import type { Context, MiddlewareHandler } from 'hono';

/** Indexer freshness metadata provided by the route handler's query. */
export interface FreshnessMeta {
  /** The most recently indexed block number. */
  lastIndexedBlock: bigint;
  /** ISO 8601 timestamp of when that block was indexed. */
  lastIndexedAt: string;
  /** Optional route-specific validator when one block number is not enough. */
  validator?: string;
}

/**
 * Hono middleware factory that adds ETag / Cache-Control HTTP-cache semantics.
 *
 * Pass a synchronous or async function that returns {@link FreshnessMeta}.
 * The function optionally receives the Hono `Context` so callers can stash
 * computed values (e.g. `c.set('indexedHead', meta)`) for re-use by the
 * downstream route handler — avoiding a second DB round-trip.
 *
 * The middleware:
 * 1. Computes `ETag: W/"<validator>"`.
 * 2. If the request's `If-None-Match` header equals the current ETag,
 *    responds with `304 Not Modified` and an empty body (short-circuit).
 * 3. Otherwise, calls `next()` and then sets `ETag` and `Cache-Control` on
 *    the response that the downstream handler produced.
 *
 * Backward-compatible with zero-arg callbacks: passing `() => meta` still works
 * because JS does not enforce function arity.
 *
 * @example Zero-arg (simple case, no context stash needed):
 * ```ts
 * app.use('/explorer/*', withFreshness(async () => {
 *   const row = await db.select(...).from(someTable).limit(1);
 *   return { lastIndexedBlock: row.block, lastIndexedAt: row.indexedAt };
 * }));
 * ```
 *
 * @example Context-aware (stash for route body to read):
 * ```ts
 * app.use('/explorer/*', withFreshness(async (c) => {
 *   const meta = { lastIndexedBlock: await getHead(), lastIndexedAt: ... };
 *   c.set('indexedHead', meta);
 *   return meta;
 * }));
 * // In the route body:
 * const meta = c.get('indexedHead');
 * ```
 */
export function withFreshness(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getMeta: (c: Context<any>) => FreshnessMeta | Promise<FreshnessMeta>,
): MiddlewareHandler {
  return async (c, next) => {
    const meta = await getMeta(c);
    const token = (meta.validator ?? meta.lastIndexedBlock.toString()).replace(/["\\]/g, '-');
    const etag = `W/"${token}"`;

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
