// SPDX-License-Identifier: Apache-2.0
// Generates the golden, equivalence, and adversarial fixture corpora from the schema.
// Fixtures are derived from the specification and this generator, never captured from a
// product run. Run with `--write`; run with `--check` in CI to detect drift.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixtures = join(root, "fixtures");

const {
  TRAJECTORY_PROTOCOL,
  TRAJECTORY_VOCABULARY_PROFILE,
  deriveSpanId,
  deriveTraceId,
  sealTrajectory,
} = await import(join(root, "dist", "index.js"));

const SOURCE_SHA = "a".repeat(64);
const FORMAT_IRI = "https://jinn.network/formats/claude-code-stream-json/v1";
const DECODER = { decoderId: "claude-code-stream-json", decoderVersion: "1.0.0" };
const traceId = deriveTraceId({
  sourceDigest: `sha256:${SOURCE_SHA}`,
  formatIri: FORMAT_IRI,
  vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
  ...DECODER,
});

const base = () => ({
  protocol: TRAJECTORY_PROTOCOL,
  source: {
    nativeTrace: {
      name: "stdout.jsonl",
      mediaType: "application/x-ndjson",
      digest: { sha256: SOURCE_SHA },
    },
    formatIri: FORMAT_IRI,
  },
  derivation: { ...DECODER, vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE },
  timebase: "synthetic-ordinal",
  traceId,
  spans: [],
  completeness: { decoded: "empty" },
});

const span = (ordinal, overrides = {}) => ({
  spanId: deriveSpanId(traceId, ordinal),
  parentSpanId: null,
  name: "chat anthropic/claude-opus-4.6",
  kind: 3,
  startTimeUnixNano: String(ordinal),
  endTimeUnixNano: String(ordinal + 1),
  attributes: [
    { key: "gen_ai.provider.name", value: { stringValue: "anthropic" } },
    { key: "gen_ai.usage.input_tokens", value: { intValue: "1024" } },
  ],
  events: [],
  status: { code: 1 },
  ...overrides,
});

const valid = () => ({
  ...base(),
  spans: [
    span(0),
    span(1, {
      name: "execute_tool read_file",
      kind: 1,
      parentSpanId: deriveSpanId(traceId, 0),
      attributes: [
        { key: "gen_ai.tool.call.id", value: { stringValue: "call_1" } },
        { key: "gen_ai.tool.name", value: { stringValue: "read_file" } },
      ],
    }),
  ],
  completeness: { decoded: "full" },
});

const minimal = () => base();

const invalid = {
  "forged-trace-id": () => ({ ...valid(), traceId: "f".repeat(32) }),
  "forged-span-id": () => {
    const document = valid();
    document.spans[0].spanId = "f".repeat(16);
    return document;
  },
  "unsorted-attributes": () => {
    const document = valid();
    document.spans[0].attributes = [...document.spans[0].attributes].reverse();
    return document;
  },
  "unknown-extension-key": () => ({ ...valid(), note: "not namespaced" }),
};

const adversarial = {
  "partial-without-skipped": {
    description: "A partial decode that does not report how many source records were skipped.",
    expectedDisposition: "invalid-document",
    document: () => ({ ...valid(), completeness: { decoded: "partial" } }),
  },
  "empty-with-spans": {
    description: "An empty decode that nevertheless carries spans.",
    expectedDisposition: "invalid-document",
    document: () => ({ ...valid(), completeness: { decoded: "empty" } }),
  },
  "full-with-skipped": {
    description: "A full decode that illegally reports skipped source records.",
    expectedDisposition: "invalid-document",
    document: () => ({ ...valid(), completeness: { decoded: "full", skipped: 1 } }),
  },
  "grafted-parent": {
    description: "A span whose parent identifier belongs to no earlier span in this record.",
    expectedDisposition: "invalid-document",
    document: () => {
      const document = valid();
      document.spans[1].parentSpanId = "0".repeat(16);
      return document;
    },
  },
  "substituted-source-digest": {
    description:
      "Spans copied verbatim onto a different source digest — the derived identifiers no longer agree.",
    expectedDisposition: "invalid-document",
    document: () => {
      const document = valid();
      document.source.nativeTrace.digest.sha256 = "b".repeat(64);
      return document;
    },
  },
  "message-content-attribute": {
    description: "A span that inlines message content instead of referencing the source.",
    expectedDisposition: "invalid-document",
    document: () => {
      const document = valid();
      document.spans[0].attributes = [
        { key: "message.content", value: { stringValue: "inline" } },
      ];
      return document;
    },
  },
  "nested-native-trace-key": {
    description: "An undeclared key nested under source.nativeTrace.",
    expectedDisposition: "invalid-document",
    document: () => {
      const document = valid();
      document.source.nativeTrace.bad = true;
      return document;
    },
  },
  "namespaced-extension-preserved": {
    description: "An unknown but namespaced extension key, which must survive round-trips.",
    expectedDisposition: "accepted",
    document: () => ({ ...valid(), "network.jinn.note": "kept" }),
  },
};

const write = process.argv.includes("--write");
const failures = [];

async function emit(relativePath, contents) {
  const target = join(fixtures, relativePath);
  const text = typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`;
  if (write) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
    return;
  }
  const existing = await readFile(target, "utf8").catch(() => null);
  if (existing !== text) failures.push(relativePath);
}

for (const [name, build] of [["valid", valid], ["minimal", minimal]]) {
  const document = build();
  const sealed = sealTrajectory(document);
  await emit(`trajectory/${name}.json`, new TextDecoder().decode(sealed.bytes));
  await emit(`trajectory/${name}.sha256`, `${sealed.digest}\n`);
}

for (const [name, build] of Object.entries(invalid)) {
  await emit(`trajectory/invalid-${name}.json`, build());
}

const permuted = (value) =>
  Array.isArray(value)
    ? value.map(permuted)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, permuted(v)]))
      : value;

await emit("equivalence/input-a.json", valid());
await emit("equivalence/input-b.json", permuted(valid()));
await emit("equivalence/expected-digest.json", { digest: sealTrajectory(valid()).digest });

const manifest = { fixtures: [] };
for (const [id, entry] of Object.entries(adversarial)) {
  await emit(`adversarial-v1/${id}/document.json`, entry.document());
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
