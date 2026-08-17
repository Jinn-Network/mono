#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Seals Demo-1's Benchmark Definition and Analysis Manifest from the current declaration,
 * before the cells they govern are complete.
 *
 *   cd packages/benchmark-product/core && yarn build && node scripts/demo1-preregister.mjs
 *
 * Both records are deterministic functions of the declaration, so the final report build reseals
 * byte-identical records; `yarn demo1:verify` checks that equality. Committing this file before
 * the deep run completes is what makes the analysis pre-declared rather than post hoc.
 *
 * Reads no cell and no reward.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordDigest } from "@jinn-network/evidence-protocol";
import { SKILLSBENCH_DEMO1_PILOT_DECLARATION } from "../dist/method/skillsbench-demo1-current.js";
import {
  demo1DeclaredCellCount,
  sealDemo1Definition,
  sealDemo1Manifest,
} from "../dist/method/skillsbench-demo1-seal.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_ROOT = resolve(PACKAGE_ROOT, "../../..");
const OUT = resolve(REPO_ROOT, "docs/superpowers/plans/demo-report-1/E1-demo1-preregistration.v1.json");

const stage = process.env.SKILLSBENCH_DEMO1_STAGE === "final" ? "final" : "pilot";
const declaration = SKILLSBENCH_DEMO1_PILOT_DECLARATION;

const benchmark = sealDemo1Definition(declaration);
const manifest = sealDemo1Manifest(declaration, stage);
const encoder = new TextEncoder();
const declarationDigest = recordDigest(encoder.encode(JSON.stringify(declaration)));

writeFileSync(OUT, `${JSON.stringify({
  schema: "jinn.demo1.preregistration.v1",
  stage,
  declaration,
  declarationDigest,
  declaredCells: demo1DeclaredCellCount(declaration),
  benchmark: Buffer.from(benchmark.bytes).toString("base64"),
  manifest: Buffer.from(manifest.bytes).toString("base64"),
  digests: { benchmark: benchmark.digest, analysisManifest: manifest.digest },
}, null, 2)}\n`);

console.log(`preregistered stage=${stage}`);
console.log(`declaration ${declarationDigest} (${demo1DeclaredCellCount(declaration)} cells)`);
console.log(`manifest ${manifest.digest}`);
console.log(`sealed ${OUT}`);
