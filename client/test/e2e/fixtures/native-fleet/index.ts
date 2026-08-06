/**
 * Reusable native-fleet e2e fixtures (one-swap M7, umbrella #2461, DR-2026-08-05).
 *
 * The five deliverable-3 fixtures the native rig and future native tests share:
 *   - identity stores for the native role families (`identity.ts`)
 *   - a trust catalog binding those minted keys, real- or mock-anchored (`trust-catalog.ts`)
 *   - a two-operator native config (`config.ts`)
 *   - a launched-SolverNet record + posting entry (`launched-record.ts`)
 *   - the on-chain anchor submitter that turns a binding digest into a finalized fork tx
 *     (`anchor.ts`)
 */
export * from './identity.js';
export * from './trust-catalog.js';
export * from './launched-record.js';
export * from './config.js';
export * from './anchor.js';
