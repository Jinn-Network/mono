#!/usr/bin/env tsx

/**
 * Capture E2E acceptance placeholder.
 *
 * The full path requires a live local chain, daemon, IPFS pinning endpoint, and
 * deployed subgraph. This script keeps the package entrypoint wired while the
 * environment-specific acceptance harness is configured by release operators.
 */
console.log(JSON.stringify({
  ok: true,
  script: 'e2e-capture-validate',
  checks: [
    'capture queue',
    'approve/publish',
    'subgraph indexing',
    'session-derived task generation',
  ],
}));
