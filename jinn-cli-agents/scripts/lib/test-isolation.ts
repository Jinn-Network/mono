/**
 * Test Isolation Utilities - Thin Wrapper
 *
 * This is a thin wrapper that re-exports from jinn-node.
 * The source of truth is in jinn-node/src/setup/test-isolation.ts
 */

export {
  createIsolatedMiddlewareEnvironment,
  type IsolatedEnvironment
} from 'jinn-node/setup/test-isolation.js';
