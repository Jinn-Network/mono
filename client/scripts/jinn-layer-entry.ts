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
  createBoundedRawHfRowFetcher,
  createSweRebenchV2VerifierFactsResolver,
} from '../src/solver-types/_swe-rebench-v2-verifier-facts.js';

const fetchHfRawRow = createBoundedRawHfRowFetcher();

runJinnLayerCli(process.argv.slice(2), {
  distillRunDeps: {
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
