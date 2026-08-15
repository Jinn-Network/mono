// Emits the two published JSON Schemas. `--write` regenerates; `--check` detects drift.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const mode = process.argv.includes("--write") ? "--write" : "--check";

const {
  CHAIN_ENVIRONMENT_SCHEMA_ID,
  CRYPTO_ENVIRONMENT_SCHEMA_ID,
  ChainEnvironmentRecordSchema,
  CryptoEnvironmentRecordSchema,
} = await import(join(root, "dist", "index.js"));

const NAMESPACED =
  "^(?:[A-Za-z][A-Za-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*)+|[A-Za-z][A-Za-z0-9+.-]*:[^\\s]+)$";

/**
 * `z.toJSONSchema` drops `.superRefine()` predicates. Most of this package's invariants are
 * cross-field and genuinely inexpressible in JSON Schema; the top-level namespacing rule is
 * not, and it is restored here so a third party validating with the published document reaches
 * the same verdict on the case most likely to matter — an un-namespaced key beside a core one.
 * Everything else is named in `$comment` rather than silently omitted.
 */
function emit(schema, { $id, title, description, comment }) {
  const document = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" });
  document.$id = $id;
  document.title = title;
  document.description = description;
  document.propertyNames = {
    anyOf: [{ enum: Object.keys(document.properties ?? {}) }, { pattern: NAMESPACED }],
  };
  document.$comment = comment.join(" ");
  return document;
}

const chain = emit(ChainEnvironmentRecordSchema, {
  $id: CHAIN_ENVIRONMENT_SCHEMA_ID,
  title: "Jinn chain environment record",
  description:
    "A sealed description of one sandboxed chain world: a pinned simulator runtime, an optional "
    + "source anchor, a state materialization with its closure and fidelity classes, ordered "
    + "digest-pinned fixtures, the determinism controls, the agent-facing capability envelope, "
    + "and the verification contract. The document states what the world is; it makes no claim "
    + "that the world boots or reproduces, and it does not assert correspondence to a public "
    + "chain beyond the fidelity class it declares. Those claims live in separately published "
    + "attestations and are bounded there.",
  comment: [
    "Structural validation only. These checks are cross-field and are enforced at runtime, not here:",
    "sourceAnchor is present exactly when fidelityClass is not `local`;",
    "stateMaterialization.initialStateCommitment MUST differ from sourceAnchor.stateRoot;",
    "for a non-local artifact, sourceProofManifest.coverage plus fixtureCoverage.declared must equal",
    "stateArtifact.entryCounts in every category, or the record is source-coverage-incomplete;",
    "mutatesSourceProtocolState must be true when fixtures mutate proof-covered accounts;",
    "capabilityEnvelope.permittedChainId must equal runtime.evm.sandboxChainId;",
    "every signer account must be a declared fixture account, and no fixture account may be a",
    "well-known development-mnemonic address;",
    "verificationContract.fixtureProbeCoverage must name every fixture module and no others;",
    "a closed-state record requires the blackhole egress policy, closureCheckRequired, a state",
    "artifact, no archive declaration, and a fresh-process reset;",
    "runtime.image.reference must end with @<manifestDigest> and indexDigest must differ from it;",
    "and the record's bytes must be the exact RFC 8785 canonical encoding of the document.",
  ],
});

const composite = emit(CryptoEnvironmentRecordSchema, {
  $id: CRYPTO_ENVIRONMENT_SCHEMA_ID,
  title: "Jinn crypto environment record",
  description:
    "A sealed composite of worlds: one chain world, zero or more information worlds, pinned "
    + "service runtimes, and the composition block binding origin routing, precedence, the miss "
    + "policy, the reachable-endpoint allowlist, and the request budget. A task references this "
    + "record; components are sealed and attested independently.",
  comment: [
    "Structural validation only. These checks are cross-field and are enforced at runtime, not here:",
    "chainWorld.kind must be the chain-environment kind and no information world may claim it;",
    "information-world ids and service-runtime ids must be unique;",
    "every route must name a declared world and an origin on the endpointAllowlist;",
    "two worlds may share an origin only at distinct precedence, and one world routes an origin once;",
    "a composite with no information worlds routes nothing and carries a zero requestBudget, while",
    "a composed one requires a positive requestBudget;",
    "and the record's bytes must be the exact RFC 8785 canonical encoding of the document.",
  ],
});

const targets = [
  [join(root, "schemas", "chain-environment.schema.json"), chain],
  [join(root, "schemas", "crypto-environment.schema.json"), composite],
];

let drifted = false;
for (const [target, document] of targets) {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (mode === "--write") {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
    continue;
  }
  const existing = await readFile(target, "utf8").catch(() => null);
  if (existing !== text) {
    console.error(`published schema is out of date: ${target}`);
    drifted = true;
  }
}

if (drifted) {
  console.error("run `yarn generate:schemas`");
  process.exit(1);
}
console.log(mode === "--write" ? "schemas written" : "schemas up to date");
