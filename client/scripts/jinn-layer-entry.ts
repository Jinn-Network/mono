#!/usr/bin/env node
/**
 * Production jinn-layer composition root.
 *
 * This executable-only build entry composes the independently typechecked
 * client and harness-layer modules without adding a dependency edge in either
 * production source tree. The shipped binary is emitted by esbuild.
 */

import { runJinnLayerCli } from '../packages/harness-layer/src/cli.js';
import {
  DEFAULT_TESTNET_IDENTITY_REGISTRY,
  DEFAULT_TESTNET_RPC_URL,
} from '../packages/harness-layer/src/publish-live.js';
import { authenticateExecutionEnvelope } from '../src/conformance/execution-envelope-authenticator.js';
import { createPublisherSafeResolver } from '../src/erc8004/publisher-safe-resolver.js';
import {
  createBoundedRawHfRowFetcher,
  createSweRebenchV2VerifierFactsResolver,
} from '../src/solver-types/_swe-rebench-v2-verifier-facts.js';

const fetchHfRawRow = createBoundedRawHfRowFetcher();
const resolvePublisherSafe = createPublisherSafeResolver({
  rpcUrl: process.env['JINN_RPC_URL'] ?? DEFAULT_TESTNET_RPC_URL,
  fallbackRpcUrls: ['https://sepolia.base.org'],
  expectedChainId: 84532,
  identityRegistry:
    process.env['JINN_LAYER_IDENTITY_REGISTRY']
    ?? DEFAULT_TESTNET_IDENTITY_REGISTRY,
});

runJinnLayerCli(process.argv.slice(2), {
  distillRunDeps: {
    authenticateEnvelope: authenticateExecutionEnvelope,
    resolvePublisherSafe,
    verifierFactsResolverFactory: (ipfs) =>
      createSweRebenchV2VerifierFactsResolver({
        fetchIpfsJson: ({ cid, maxBytes }) => ipfs(cid, maxBytes),
        fetchHfRawRow,
      }),
  },
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(
      `[jinn-layer] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
