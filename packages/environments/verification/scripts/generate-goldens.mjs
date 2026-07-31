import { mkdir, writeFile } from "node:fs/promises";
import { createEoaTestSigner } from "@jinn-network/trust-testing";
import { dssePreAuthEncoding } from "@jinn-network/trust-core";
import { buildConformanceRecord } from "../dist/import-source.js";
import {
  CONFORMANCE_VERIFIER_IDENTITY,
  createFixedClock,
  createInMemoryArtifactStore,
  createScriptedContainerRuntime,
} from "../dist/testing.js";
import { verifyEnvironment } from "../dist/verify.js";

const eoa = createEoaTestSigner("environment-verification-conformance");
const signer = async (request) => [{
  keyid: eoa.address,
  signature: eoa.sign(request.preAuthEncoding
    ?? dssePreAuthEncoding(request.payloadType, request.payloadBytes)),
}];

await mkdir("fixtures/attestations-v1", { recursive: true });
for (const [name, scenario] of [
  ["stable", { kind: "stable" }],
  ["unstable-divergence", { kind: "flaky-on-run-3" }],
  ["error-acquire", { kind: "vanishing-image" }],
]) {
  const { statement } = await verifyEnvironment(
    {
      containerRuntime: createScriptedContainerRuntime(scenario),
      artifactStore: createInMemoryArtifactStore(),
      signer,
      clock: createFixedClock(),
      verifier: CONFORMANCE_VERIFIER_IDENTITY,
    },
    buildConformanceRecord(),
  );
  await writeFile(
    `fixtures/attestations-v1/${name}.json`,
    `${JSON.stringify(statement, null, 2)}\n`,
    "utf8",
  );
}
console.log("goldens written");
