// SPDX-License-Identifier: Apache-2.0
// Emits the published JSON Schema. `--write` regenerates; the default checks for drift.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const {
  TRAJECTORY_RECORD_KIND,
  TrajectoryRecordSchema,
  GEN_AI_ATTRIBUTES,
  JINN_ATTRIBUTES,
  TIMEBASES,
} = await import(join(root, "dist", "index.js"));

const NAMESPACED =
  "^(?:[A-Za-z][A-Za-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*)+|[A-Za-z][A-Za-z0-9+.-]*:[^\\s]+)$";

const ADMITTED_ATTRIBUTE_KEYS = [
  ...Object.values(GEN_AI_ATTRIBUTES),
  ...Object.values(JINN_ATTRIBUTES),
];

const schema = z.toJSONSchema(TrajectoryRecordSchema, {
  target: "draft-2020-12",
  unrepresentable: "any",
});

schema.$id = `${TRAJECTORY_RECORD_KIND}/schema`;
schema.title = "Jinn Trajectory record";
schema.propertyNames = {
  anyOf: [{ enum: Object.keys(schema.properties ?? {}) }, { pattern: NAMESPACED }],
};

if (schema.properties?.timebase) {
  schema.properties.timebase = { type: "string", enum: [...TIMEBASES] };
}

function patchAttributeKeys(node) {
  if (!node || typeof node !== "object") return;
  if (node.properties?.key?.type === "string" && node.properties?.value) {
    node.properties.key = { type: "string", enum: ADMITTED_ATTRIBUTE_KEYS };
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(patchAttributeKeys);
    else if (value && typeof value === "object") patchAttributeKeys(value);
  }
}

patchAttributeKeys(schema);

function closeUndeclaredNestedKeys(node) {
  if (!node || typeof node !== "object") return;
  if (
    node.type === "object" &&
    node.additionalProperties &&
    typeof node.additionalProperties === "object" &&
    !node.propertyNames &&
    Object.keys(node.additionalProperties).length === 0
  ) {
    node.additionalProperties = false;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(closeUndeclaredNestedKeys);
    else if (value && typeof value === "object") closeUndeclaredNestedKeys(value);
  }
}

closeUndeclaredNestedKeys(schema);

schema.allOf = [
  {
    if: {
      properties: {
        completeness: {
          type: "object",
          properties: { decoded: { const: "full" } },
          required: ["decoded"],
        },
      },
      required: ["completeness"],
    },
    then: {
      properties: {
        completeness: {
          properties: { skipped: false },
        },
      },
    },
  },
  {
    if: {
      properties: {
        completeness: {
          type: "object",
          properties: { decoded: { const: "partial" } },
          required: ["decoded"],
        },
      },
      required: ["completeness"],
    },
    then: {
      properties: {
        completeness: {
          required: ["skipped"],
          properties: { skipped: { type: "integer", minimum: 1 } },
        },
      },
    },
  },
  {
    if: {
      properties: {
        completeness: {
          type: "object",
          properties: { decoded: { const: "empty" } },
          required: ["decoded"],
        },
      },
      required: ["completeness"],
    },
    then: {
      properties: {
        spans: { maxItems: 0 },
      },
    },
  },
];

schema.$comment = [
  "Structural validation only. Runtime refinements not expressible here:",
  "traceId must equal the value derived from source.nativeTrace.digest, formatIri, and derivation;",
  "each spanId must equal the value derived from traceId and its ordinal;",
  "parentSpanId must reference an earlier span in this record;",
  "attributes must be sorted by key and unique;",
  "completeness: full forbids skipped; partial requires skipped >= 1; empty requires spans.length === 0;",
  "source.execution is removed — execution binding is via derivation attestation and forward link.",
].join(" ");

const target = join(root, "schemas", "trajectory.schema.json");
const text = `${JSON.stringify(schema, null, 2)}\n`;
if (process.argv.includes("--write")) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
  console.log("schema written");
} else {
  const existing = await readFile(target, "utf8").catch(() => null);
  if (existing !== text) {
    console.error("published schema is out of date; run `yarn generate:schemas`");
    process.exit(1);
  }
  console.log("schema up to date");
}
