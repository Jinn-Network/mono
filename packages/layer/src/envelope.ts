/**
 * Re-export shim — the canonical trace-envelope schema now lives in
 * `@jinn-network/core` (moved in C2, #1833). This file keeps the ~13
 * harness-layer `./envelope.js` importers unchanged while the schema lives
 * one package up. Import the surface from core:
 *
 *   import { TraceEnvelopeV0Schema } from '@jinn-network/core';
 */
export * from '@jinn-network/core';
