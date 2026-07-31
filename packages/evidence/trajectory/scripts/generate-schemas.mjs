// SPDX-License-Identifier: Apache-2.0
// Emits published JSON Schemas. `--write` regenerates; the default checks for drift.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const dist = await import(join(root, "dist", "index.js"));
const otlpBounds = await import(join(root, "dist", "otlp-bounds.js"));

const {
  TRAJECTORY_RECORD_KIND,
  TRAJECTORY_DERIVATION_STATEMENT_KIND,
  TrajectoryRecordSchema,
  TrajectoryDerivationStatementSchema,
  GEN_AI_ATTRIBUTES,
  JINN_ATTRIBUTES,
  TIMEBASES,
  LINKAGE_MODES,
} = dist;

const NAMESPACED =
  "^(?:[A-Za-z][A-Za-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*)+|[A-Za-z][A-Za-z0-9+.-]*:[^\\s]+)$";

const ADMITTED_ATTRIBUTE_KEYS = [
  ...Object.values(GEN_AI_ATTRIBUTES),
  ...Object.values(JINN_ATTRIBUTES),
];

const UINT64_DECIMAL_PATTERN = otlpBounds.uint64DecimalJsonSchemaPattern();

const INT64_DECIMAL_SCHEMA_NODE = otlpBounds.int64DecimalJsonSchemaNode();
const UINT64_DECIMAL_SCHEMA_PATTERN = UINT64_DECIMAL_PATTERN;

const ANY_VALUE_DEF = {
  oneOf: [
    {
      type: "object",
      required: ["stringValue"],
      properties: { stringValue: { type: "string" } },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["boolValue"],
      properties: { boolValue: { type: "boolean" } },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["intValue"],
      properties: { intValue: { $ref: "#/$defs/Int64DecimalString" } },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["doubleValue"],
      properties: { doubleValue: { type: "string", pattern: "^-?\\d+(\\.\\d+)?$" } },
      additionalProperties: false,
    },
  ],
};

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

function patchAnyValueRefs(node, parent, key) {
  if (!node || typeof node !== "object") return;
  if (
    node.type === "object" &&
    node.properties?.stringValue &&
    node.properties?.boolValue &&
    node.properties?.intValue &&
    node.properties?.doubleValue &&
    parent &&
    key !== undefined
  ) {
    parent[key] = { $ref: "#/$defs/AnyValue" };
    return;
  }
  if (node.type === "object" && node.oneOf && parent && key !== undefined) {
    const looksLikeAnyValue = node.oneOf.every(
      (branch) =>
        branch.type === "object" &&
        branch.additionalProperties === false &&
        branch.required?.length === 1 &&
        ["stringValue", "boolValue", "intValue", "doubleValue"].includes(branch.required[0]),
    );
    if (looksLikeAnyValue) {
      parent[key] = { $ref: "#/$defs/AnyValue" };
      return;
    }
  }
  for (const [childKey, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (entry && typeof entry === "object") patchAnyValueRefs(entry, value, index);
      });
    } else if (value && typeof value === "object") {
      patchAnyValueRefs(value, node, childKey);
    }
  }
}

function assertIntValueLaw(schema) {
  const violations = [];
  const expected = { $ref: "#/$defs/Int64DecimalString" };

  function walk(node, path) {
    if (!node || typeof node !== "object") return;
    if (node.properties?.intValue) {
      const actual = node.properties.intValue;
      const matches =
        actual.$ref === expected.$ref ||
        JSON.stringify(actual) === JSON.stringify(INT64_DECIMAL_SCHEMA_NODE);
      if (!matches) {
        violations.push(`${path}.properties.intValue`);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}/${key}[${index}]`));
      } else if (value && typeof value === "object") {
        walk(value, `${path}/${key}`);
      }
    }
  }

  walk(schema, "");
  if (violations.length > 0) {
    throw new Error(`intValue nodes diverge from Int64DecimalString law: ${violations.join(", ")}`);
  }
}

function assertUint64TimestampLaw(schema) {
  const violations = [];

  function walk(node, path) {
    if (!node || typeof node !== "object") return;
    if (node.type === "string" && node.pattern && node.pattern !== "^-?(0|[1-9]\\d*)$") {
      if (
        node.description?.includes("UnixNano") ||
        node.title?.includes("UnixNano") ||
        node.pattern === UINT64_DECIMAL_SCHEMA_PATTERN ||
        node.pattern === "^(0|[1-9]\\d*)$"
      ) {
        if (node.pattern !== UINT64_DECIMAL_SCHEMA_PATTERN) {
          violations.push(`${path}.pattern (${node.pattern})`);
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}/${key}[${index}]`));
      } else if (value && typeof value === "object") {
        walk(value, `${path}/${key}`);
      }
    }
  }

  walk(schema, "");
  if (violations.length > 0) {
    throw new Error(
      `uint64 timestamp nodes diverge from generated law: ${violations.join(", ")}`,
    );
  }
}

function patchExtensionSurface(node, coreKeys) {
  if (!node || typeof node !== "object" || node.type !== "object") return;
  node.propertyNames = {
    anyOf: [{ enum: [...coreKeys] }, { pattern: NAMESPACED }],
  };
  node.additionalProperties = { $ref: "#/$defs/JsonExtensionValue" };
}

function patchUint64Timestamps(node) {
  if (!node || typeof node !== "object") return;
  if (
    node.type === "string" &&
    node.pattern === "^(0|[1-9]\\d*)$" &&
    (node.description?.includes("UnixNano") ||
      node.title?.includes("UnixNano") ||
      node.pattern)
  ) {
    node.pattern = UINT64_DECIMAL_PATTERN;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(patchUint64Timestamps);
    else if (value && typeof value === "object") patchUint64Timestamps(value);
  }
}

function buildTrajectoryRecordSchema() {
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

  patchAttributeKeys(schema);
  closeUndeclaredNestedKeys(schema);

  schema.$defs = {
    JsonExtensionValue: {
      anyOf: [
        { type: "string" },
        { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991 },
        { type: "boolean" },
        { type: "null" },
        { type: "array", items: { $ref: "#/$defs/JsonExtensionValue" } },
        {
          type: "object",
          propertyNames: { pattern: NAMESPACED },
          additionalProperties: { $ref: "#/$defs/JsonExtensionValue" },
        },
      ],
    },
    Int64DecimalString: INT64_DECIMAL_SCHEMA_NODE,
    AnyValue: ANY_VALUE_DEF,
  };

  patchAnyValueRefs(schema);
  patchExtensionSurface(schema, Object.keys(schema.properties ?? {}));

  const nativeTrace = schema.properties?.source?.properties?.nativeTrace;
  if (nativeTrace) {
    patchExtensionSurface(nativeTrace, ["name", "mediaType", "uri", "digest"]);
  }

  patchUint64Timestamps(schema);
  assertIntValueLaw(schema);
  assertUint64TimestampLaw(schema);

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
    "source.execution is removed — execution binding is via derivation attestation and forward link.",
    "JsonExtensionValue numbers are I-JSON safe integers only (±9007199254740991).",
    "AnyValue must carry exactly one OTLP variant (stringValue, boolValue, intValue, or doubleValue).",
    "OTLP uint64 timestamps are decimal strings 0..18446744073709551615; intValue is int64 decimal.",
    "derivedAt calendar-strict RFC 3339 refinements on derivation statements are enforced at runtime.",
  ].join(" ");

  return schema;
}

function buildDerivationStatementSchema() {
  const schema = z.toJSONSchema(TrajectoryDerivationStatementSchema, {
    target: "draft-2020-12",
    unrepresentable: "any",
  });

  schema.$id = `${TRAJECTORY_DERIVATION_STATEMENT_KIND}/schema`;
  schema.title = "Jinn Trajectory derivation statement";
  schema.additionalProperties = false;

  if (schema.properties?.subject) {
    schema.properties.subject = {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: schema.properties.subject.prefixItems?.[0] ?? {
        type: "object",
        properties: {
          name: { type: "string", const: "trajectory.json" },
          digest: {
            type: "object",
            properties: { sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } },
            required: ["sha256"],
            additionalProperties: false,
          },
          mediaType: { type: "string", const: "application/vnd.jinn.trajectory.v1+json" },
        },
        required: ["name", "digest", "mediaType"],
        additionalProperties: false,
      },
    };
    delete schema.properties.subject.prefixItems;
  }

  if (schema.properties?.predicate?.properties?.linkageMode) {
    schema.properties.predicate.properties.linkageMode = {
      type: "string",
      enum: [...LINKAGE_MODES],
    };
  }
  if (schema.properties?.predicate?.properties?.timebase) {
    schema.properties.predicate.properties.timebase = { type: "string", enum: [...TIMEBASES] };
  }
  if (schema.properties?.predicate?.properties?.derivedAt) {
    schema.properties.predicate.properties.derivedAt = {
      type: "string",
      format: "date-time",
    };
  }

  closeUndeclaredNestedKeys(schema);

  schema.$comment = [
    "Structural validation of the decoded DSSE/in-toto statement payload only.",
    "Does not validate envelope signatures or authority trust.",
    "linkageMode is required and closed to forward-linked | sealed-parent.",
    "subject must contain exactly one trajectory.json entry.",
    "derivedAt uses format date-time; calendar-strict RFC 3339 (leap days, timezone, no Date.parse rollover) is enforced at runtime.",
  ].join(" ");

  return schema;
}

const targets = [
  { name: "trajectory.schema.json", build: buildTrajectoryRecordSchema },
  {
    name: "trajectory-derivation-statement.schema.json",
    build: buildDerivationStatementSchema,
  },
];

async function checkOrWrite() {
  const write = process.argv.includes("--write");
  for (const target of targets) {
    const path = join(root, "schemas", target.name);
    const text = `${JSON.stringify(target.build(), null, 2)}\n`;
    if (write) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
      console.log(`wrote ${target.name}`);
    } else {
      const existing = await readFile(path, "utf8").catch(() => null);
      if (existing !== text) {
        console.error(`published schema ${target.name} is out of date; run \`yarn generate:schemas\``);
        process.exit(1);
      }
      console.log(`${target.name} up to date`);
    }
  }
}

await checkOrWrite();
