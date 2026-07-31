// Generates the golden, equivalence, and adversarial fixture corpora from the schema.
// Fixtures are derived from the specification and this generator, never captured from a
// product run. `--write` regenerates; `--check` (the default) detects drift.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixturesRoot = join(root, "fixtures");

const { ENVIRONMENT_RECORD_KIND, environmentRecordDigest, sealEnvironmentRecord } = await import(
  join(root, "dist", "index.js")
);

const MANIFEST = `sha256:${"1".repeat(64)}`;
const INDEX = `sha256:${"2".repeat(64)}`;
const PARSER = `sha256:${"3".repeat(64)}`;
const RECIPE = "4".repeat(64);

/** A synthetic SWE-rebench-shaped import: tier 0, lineage present, pre-installed image. */
const imported = () => ({
  kind: ENVIRONMENT_RECORD_KIND,
  source: {
    repo: "example-org/example-lib",
    repoUrl: "https://github.com/example-org/example-lib",
    commit: "0".repeat(39) + "1",
  },
  image: {
    manifestDigest: MANIFEST,
    platform: "linux/amd64",
    reference: `registry.example.test/swe/example-lib@${MANIFEST}`,
    indexDigest: INDEX,
  },
  workspace: "/testbed",
  invocations: {
    test: [{ bin: "python", args: ["-m", "pytest", "-q", "tests/test_core.py"], cwd: "/testbed" }],
  },
  parser: {
    id: "pytest-text",
    version: "1.0.0",
    digest: PARSER,
    uri: "https://example.test/parsers/pytest-text-1.0.0.tar.gz",
  },
  build: { reproducibilityTier: 0, provider: { id: "swe-rebench", version: "2" } },
  rights: { sourceLicense: "Apache-2.0", basis: "upstream-permissive-filter" },
  lineage: {
    upstream: {
      dataset: "example/upstream-dataset",
      revision: "0".repeat(40),
      keys: ["example-org__example-lib-4242"],
    },
  },
});

/** Tier 1: rebuildable, so recipe + dependencyPinning are mandatory. */
const tierOne = () => ({
  ...imported(),
  image: { manifestDigest: MANIFEST, platform: "linux/amd64" },
  invocations: {
    install: [{ bin: "pip", args: ["install", "-e", "."], cwd: "/testbed" }],
    test: [{ bin: "python", args: ["-m", "pytest", "-q"], cwd: "/testbed" }],
  },
  build: {
    reproducibilityTier: 1,
    recipe: {
      name: "Dockerfile",
      mediaType: "text/x-dockerfile",
      digest: { sha256: RECIPE },
    },
    dependencyPinning: { mechanism: "pip-by-date", asOf: "2026-01-01T00:00:00Z" },
    provider: { id: "example-builder", version: "0.3.0" },
  },
  lineage: undefined,
});

/** A record carrying an unknown but namespaced extension key, which must survive sealing. */
const extension = () => ({
  ...imported(),
  "network.jinn.note": "an extension key a future consumer added",
  "https://example.test/ext/provenance": { collector: "example" },
});

const invalid = {
  "index-digest-as-manifest": () => {
    const document = imported();
    document.image.indexDigest = document.image.manifestDigest;
    return document;
  },
  "reference-not-ending-in-digest": () => {
    const document = imported();
    document.image.reference = "registry.example.test/swe/example-lib:latest";
    return document;
  },
  "shell-command": () => {
    const document = imported();
    document.invocations.test = [{ bin: "bash", args: ["-c", "pytest -q && echo done"] }];
    return document;
  },
  "bare-extension-key": () => ({ ...imported(), note: "not namespaced" }),
  "bare-hex-manifest-digest": () => {
    const document = imported();
    document.image.manifestDigest = "1".repeat(64);
    delete document.image.reference;
    return document;
  },
};

const adversarial = {
  "index-digest-as-manifest": {
    description:
      "The multi-arch index digest presented as the platform manifest digest. Behaviour claims "
      + "are per-platform facts; an index-level record would be a lie by aggregation.",
    expectedDisposition: "invalid-document",
    document: invalid["index-digest-as-manifest"],
  },
  "reference-not-ending-in-digest": {
    description:
      "An advisory pull reference that does not pin the record's own manifest digest, so it can "
      + "resolve to different bytes than the record identifies.",
    expectedDisposition: "invalid-document",
    document: invalid["reference-not-ending-in-digest"],
  },
  "shell-command": {
    description: "An invocation that reintroduces shell interpolation by naming a shell as bin.",
    expectedDisposition: "invalid-document",
    document: invalid["shell-command"],
  },
  "bare-extension-key": {
    description: "An un-namespaced extension key, indistinguishable from a smuggled core field.",
    expectedDisposition: "invalid-document",
    document: invalid["bare-extension-key"],
  },
  "bare-hex-manifest-digest": {
    description:
      "Digest confusion: an in-toto DigestSet subject spelling (bare hex) used in the record "
      + "body, where every digest is sha256:-prefixed.",
    expectedDisposition: "invalid-document",
    document: invalid["bare-hex-manifest-digest"],
  },
  "namespaced-extension-preserved": {
    description: "A namespaced extension key, which must survive sealing and re-parsing.",
    expectedDisposition: "accepted",
    document: extension,
  },
  "recanonicalized-bytes": {
    description:
      "The golden record re-serialized with pretty-printing: a valid document whose bytes are "
      + "not the record's bytes, so it must not present as the same record.",
    expectedDisposition: "invalid-bytes",
    bytes: () => `${JSON.stringify(imported(), null, 2)}\n`,
  },
};

const write = process.argv.includes("--write");
const failures = [];

async function emit(relativePath, contents) {
  const target = join(fixturesRoot, relativePath);
  const text = typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`;
  if (write) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
    return;
  }
  const existing = await readFile(target, "utf8").catch(() => null);
  if (existing !== text) failures.push(relativePath);
}

/** The pinned bytes are the sealed bytes — emitted verbatim, not pretty-printed. */
async function emitGolden(name, build) {
  const document = build();
  const sealed = sealEnvironmentRecord(document);
  await emit(`environment/${name}.json`, new TextDecoder().decode(sealed));
  await emit(`environment/${name}.sha256`, `${environmentRecordDigest(sealed)}\n`);
}

await emitGolden("imported", imported);
await emitGolden("tier-1", tierOne);
await emitGolden("extension", extension);

for (const [name, build] of Object.entries(invalid)) {
  await emit(`environment/invalid-${name}.json`, build());
}

const permuted = (value) =>
  Array.isArray(value)
    ? value.map(permuted)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, member]) => [key, permuted(member)]))
      : value;

await emit("equivalence/input-a.json", imported());
await emit("equivalence/input-b.json", permuted(imported()));
await emit("equivalence/expected-digest.json", {
  digest: environmentRecordDigest(sealEnvironmentRecord(imported())),
});

const manifest = { fixtures: [] };
for (const [id, entry] of Object.entries(adversarial)) {
  if (entry.expectedDisposition === "invalid-bytes") {
    await emit(`adversarial-v1/${id}/document.bytes`, entry.bytes());
  } else {
    await emit(`adversarial-v1/${id}/document.json`, entry.document());
  }
  manifest.fixtures.push({
    id,
    description: entry.description,
    expectedDisposition: entry.expectedDisposition,
  });
}
await emit("adversarial-v1/manifest.json", manifest);

if (!write && failures.length > 0) {
  console.error(`fixture drift in:\n${failures.map((path) => `  ${path}`).join("\n")}`);
  process.exit(1);
}
console.log(write ? "fixtures written" : "fixtures up to date");
