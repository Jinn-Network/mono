/**
 * Stand-ins for Ponder's virtual modules `ponder:api` and `ponder:schema`.
 *
 * These virtual modules are resolved by the Ponder build at runtime; under
 * Vitest they cannot be imported (no resolver), which breaks tests that
 * legitimately need helpers from `src/api/explorer.ts` whose top of file
 * imports `db` and `schema` even though most exported helpers do not exercise
 * them. The vitest config aliases the two virtual specifiers to this file so
 * tests of pure helpers (`parseBoolParam`, `verdictTruth`, etc.) can import
 * them without booting Ponder.
 *
 * Any test that actually exercises a DB-touching code path through these
 * stubs will fail loudly when `db.select(...)` is called — that's intentional;
 * those code paths belong under integration tests, not these unit tests.
 */

const stubProxy: unknown = new Proxy(
  {},
  {
    get() {
      // Return another proxy so any chained access (`db.select(...).from(schema.task)`)
      // works for type-only references. Calling the proxy throws — tests that
      // hit DB code through these stubs surface the boundary clearly.
      return stubProxy;
    },
    apply() {
      throw new Error(
        'ponder virtual-module stub called at runtime — this helper is for ' +
          'type-only test imports, not for exercising DB code paths.',
      );
    },
  },
);

export const db: unknown = stubProxy;
export default stubProxy;
