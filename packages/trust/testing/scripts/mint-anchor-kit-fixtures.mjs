#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Regenerates the one kit-minted token committed under `fixtures/anchor-kit-v1/`.
//
// The token is deterministic, so this script normally writes bytes identical to
// the ones already committed -- and committed fixtures are append-only forever
// (the stack's fixture-immutability gate). If this script produces different
// bytes, a builder changed: the committed token stops describing what the
// builders mint, the cross-validation transcript stops describing the committed
// token, and the honest resolution is a new fixture plus a dated erratum, never
// an edit. `src/anchor-kit/real-tokens.test.ts` fails loudly in that case.
//
// Usage: yarn build && node scripts/mint-anchor-kit-fixtures.mjs [--check]

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { createAnchorKitFixtures } = await import('../dist/index.js');

const fixtures = createAnchorKitFixtures();
const minted = fixtures.authority.mintTimeStampToken({ subjectSha256: fixtures.subjectSha256 });
const target = join(import.meta.dirname, '..', 'fixtures', 'anchor-kit-v1', 'kit-token-canonical.der');

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

if (process.argv.includes('--check')) {
  const committed = readFileSync(target);
  if (digest(committed) !== digest(minted.tokenDer)) {
    throw new Error(
      `kit-token-canonical.der is ${digest(committed)}; the builders now mint ${digest(minted.tokenDer)}`,
    );
  }
  process.stdout.write(`kit-token-canonical.der matches the builders (${digest(minted.tokenDer)})\n`);
} else {
  writeFileSync(target, minted.tokenDer);
  process.stdout.write(
    `wrote ${target}\n  bytes: ${minted.tokenDer.length}\n  sha256: ${digest(minted.tokenDer)}\n`
    + `  subject: ${minted.subjectSha256}\n  genTime: ${minted.facts.genTime}\n`,
  );
}
