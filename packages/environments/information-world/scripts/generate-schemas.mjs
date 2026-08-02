// Publishes the JSON Schema a third party validates a sealed information world against.
// Generated from the zod schema so the two cannot drift; `--check` fails on drift.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const target = join(root, "schemas", "information-world.schema.json");
const mode = process.argv.includes("--write") ? "--write" : "--check";

const {
  CREDENTIAL_HEADER_NAMES,
  INFORMATION_WORLD_MEDIA_TYPE,
  INFORMATION_WORLD_SCHEMA_ID,
  InformationWorldRecordSchema,
} = await import(join(root, "dist", "index.js"));
const { NAMESPACED_EXTENSION_KEY_PATTERN } = await import(join(root, "dist", "extensions.js"));
const LOWERCASE_HTTP_TOKEN = "^[a-z0-9!#$%&'*+.^_`|~-]+$";

const generated = z.toJSONSchema(InformationWorldRecordSchema, {
  target: "draft-2020-12",
  unrepresentable: "any",
});

/** Zod emits prefixItems but not the `items: false` closure of its fixed-length tuples. */
function closeFixedTuples(node) {
  if (Array.isArray(node)) {
    for (const value of node) closeFixedTuples(value);
    return;
  }
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node.prefixItems)) node.items = false;
  for (const value of Object.values(node)) closeFixedTuples(value);
}

const properties = generated.properties;
const policy = properties.requestKeyPolicy;
const corpus = properties.corpus;
const entry = corpus.properties.entries.items;
const request = entry.properties.request;
const response = entry.properties.response;
const miss = properties.missPolicy;
const capture = properties.capture;

// `superRefine` and `refine` predicates do not survive z.toJSONSchema. These predicates are
// expressible, however, so restore them here. The remaining, genuinely relational checks are
// named in $comment below and remain checked by InformationWorldRecordSchema at sealing.
policy.properties.headerSubset.items = {
  type: "string",
  pattern: LOWERCASE_HTTP_TOKEN,
  not: { enum: CREDENTIAL_HEADER_NAMES },
};
request.properties.headers.propertyNames = { pattern: LOWERCASE_HTTP_TOKEN };
for (const headers of [response.properties.headers, miss.properties.headers]) {
  headers.items.prefixItems[0] = { type: "string", pattern: LOWERCASE_HTTP_TOKEN };
}
miss.properties.status.not = { minimum: 300, maximum: 399 };
capture.allOf = [
  {
    if: { properties: { fidelity: { const: "synthetic" } } },
    then: {
      not: {
        anyOf: [
          { required: ["capturedAt"] },
          { required: ["capturer"] },
          { required: ["sources"] },
        ],
      },
    },
  },
  {
    if: { properties: { fidelity: { const: "captured-snapshot" } } },
    then: {
      required: ["capturedAt", "capturer", "sources"],
      properties: { sources: { minItems: 1 } },
    },
  },
];

closeFixedTuples(generated);

const document = {
  ...generated,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: INFORMATION_WORLD_SCHEMA_ID,
  title: "Jinn information world 1.0",
  description:
    "A sealed corpus of digest-pinned captured responses, the canonical request key that maps "
    + "a request to an entry, the fail-closed miss response an uncaptured request receives, "
    + "and the capture provenance and fidelity class the author declares. The fidelity class "
    + "is a declaration: this schema makes no claim that any source returned these bytes.",
  propertyNames: {
    anyOf: [{ enum: Object.keys(properties) }, { pattern: NAMESPACED_EXTENSION_KEY_PATTERN }],
  },
  $comment: [
    `This schema describes ${INFORMATION_WORLD_MEDIA_TYPE} records.`,
    "Structural validation plus the expressible credential, header-token, fixed-tuple,",
    "non-redirect miss, capture-provenance, and top-level namespacing rules are carried here.",
    "The UTF-8 byte limit of the inline miss body (4096 bytes), request-key rederivation from",
    "canonical request parts, strictly ascending and unique policy headers/origins/entries,",
    "entry-header membership in the policy, entry-origin membership in corpus.origins, and exact",
    "canonical encoding remain sealing-time relational checks in InformationWorldRecordSchema.",
  ].join(" "),
};

const serialized = `${JSON.stringify(document, null, 2)}\n`;

if (mode === "--write") {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, serialized, "utf8");
  console.log(`wrote ${target}`);
} else {
  const onDisk = await readFile(target, "utf8").catch(() => "");
  if (onDisk !== serialized) {
    console.error("schema drift: run `yarn generate:schemas`");
    process.exit(1);
  }
  console.log("schema matches");
}
