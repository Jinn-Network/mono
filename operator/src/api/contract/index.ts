/**
 * The read-contract barrel (spec/2026-08-04-headless-operator-rederivation-design.md §8).
 *
 * Both the daemon (`operator/src/api/*`) and the SPA (`operator/src/dashboard/spa/src/*`)
 * import response types from here. Nothing in this directory imports a Node builtin as a
 * value (see `test/architecture/contract-browser-safety.test.ts`) — only `zod/v4` and
 * type-only references to daemon-side modules, which `tsc`/`vite` erase at build time.
 */
export * from './version.js';
export * from './lifecycle-kind.js';
export * from './status.js';
export * from './health.js';
export * from './wire-types.js';
export * from './notifications.js';
