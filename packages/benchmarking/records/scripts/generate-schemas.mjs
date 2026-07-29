import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = join(packageRoot, "schemas");
const mode = process.argv[2];

if (mode !== "--write" && mode !== "--check") {
  throw new Error("Expected --write or --check");
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const NAMESPACED = "^(?:[A-Za-z][A-Za-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*)+|[A-Za-z][A-Za-z0-9+.-]*:[^\\s]+)$";
const UNIT_DECIMAL = "^(?:0*1(?:\\.0+)?|0*0\\.(?:0*[1-9]\\d*))$";

/** Zod's ResourceDescriptor.and({ digest }) emits a closed second allOf member. Runtime keeps
 * descriptor hints (notably optional `name`), so keep the digest member open and let the first
 * member define the descriptor wire vocabulary. */
function preserveDescriptorHints(node) {
  if (Array.isArray(node)) {
    node.forEach(preserveDescriptorHints);
    return;
  }
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node.allOf) && node.allOf.length === 2) {
    const digestMember = node.allOf.find((member) =>
      member?.properties?.digest !== undefined && member?.additionalProperties === false);
    if (digestMember?.additionalProperties === false) digestMember.additionalProperties = {};
  }
  Object.values(node).forEach(preserveDescriptorHints);
}

/** Draft 2020-12 cannot express Zod's refinements.  Preserve the open extension wire form,
 * while making every representable top-level/floor constraint independently enforceable. */
function postProcess(filename, schema) {
  preserveDescriptorHints(schema);
  const known = Object.keys(schema.properties ?? {});
  schema.propertyNames = { anyOf: [{ enum: known }, { pattern: NAMESPACED }] };
  if (filename === "report.schema.json") {
    schema.$comment = "Runtime checks: cross-record references, canonical byte equality, and Report cross-field invariants.";
  } else {
    schema.$comment = "Runtime checks: cross-record references, canonical byte equality, and Matrix/Run cross-field invariants.";
  }
  if (filename === "run.schema.json") {
    schema.properties.policy.properties.completenessFloor.pattern = UNIT_DECIMAL;
    schema.properties.policy.properties.completenessFloor.$comment = "Runtime check: exact BigInt completeness comparison.";
    schema.properties.closeAt.format = "date-time";
  }
  const replaceArmMaps = (node) => {
    if (node === null || typeof node !== "object") return;
    if (node.properties?.perArm !== undefined) {
      node.properties.perArm = {
        type: "object",
        propertyNames: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
        additionalProperties: {
          type: "object",
          properties: {
            expected: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, judged: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            unjudged: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, unscorable: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            expired: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, invalidated: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            excluded: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, replacements: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          },
          required: ["expected", "judged", "unjudged", "unscorable", "expired", "invalidated", "excluded", "replacements"],
          additionalProperties: false,
        },
      };
    }
    Object.values(node).forEach(replaceArmMaps);
  };
  if (filename === "matrix.schema.json") {
    schema.properties.completeness.properties.floor.pattern = UNIT_DECIMAL;
    schema.properties.completeness.properties.floor.$comment = "Runtime check: exact BigInt completeness comparison and outcome derivation.";
    schema.properties.closeBoundary.properties.at.format = "date-time";
  }
  if (filename === "report.schema.json") {
    const perSubjectCompleteness = schema.properties.disclosures.properties.perSubject.items.properties.completeness;
    perSubjectCompleteness.properties.floor.pattern = UNIT_DECIMAL;
    perSubjectCompleteness.properties.floor.$comment = "Runtime check: exact BigInt completeness comparison and outcome derivation.";
    perSubjectCompleteness.$comment = "Runtime check: per-subject completeness partition (expected, judged, attrition excluded) and runOutcome floor pairing (§8.1, §9.1).";
  }
  replaceArmMaps(schema);
  if (filename === "benchmark.schema.json" && schema.properties.reveal?.properties?.notBefore !== undefined) {
    schema.properties.reveal.properties.notBefore.format = "date-time";
  }
  return schema;
}

const { BenchmarkRecordSchema } = await import("../dist/benchmark/schema.js");
const { RunRecordSchema } = await import("../dist/run/schema.js");
const { MatrixRecordSchema } = await import("../dist/matrix/schema.js");
const { ReportRecordSchema } = await import("../dist/report/schema.js");

const FAMILIES = [
  ["benchmark.schema.json", BenchmarkRecordSchema],
  ["run.schema.json", RunRecordSchema],
  ["matrix.schema.json", MatrixRecordSchema],
  ["report.schema.json", ReportRecordSchema],
];

const assets = new Map();
for (const [filename, schema] of FAMILIES) {
  const options = filename === "matrix.schema.json" || filename === "report.schema.json"
    ? { target: "draft-2020-12", unrepresentable: "any" }
    : { target: "draft-2020-12" };
  assets.set(filename, jsonBytes(postProcess(filename, z.toJSONSchema(schema, options))));
}

const drift = [];
for (const [filename, expected] of assets) {
  const path = join(schemaRoot, filename);
  if (mode === "--write") {
    await mkdir(schemaRoot, { recursive: true });
    await writeFile(path, expected);
    continue;
  }
  let actual;
  try {
    actual = await readFile(path, "utf8");
  } catch {
    drift.push(`${filename} is missing`);
    continue;
  }
  if (actual !== expected) drift.push(`${filename} is out of date`);
}

if (drift.length > 0) {
  throw new Error(`Schema asset drift:\n- ${drift.join("\n- ")}`);
}

console.log(
  mode === "--write"
    ? `Wrote ${assets.size} JSON Schema assets.`
    : `Checked ${assets.size} JSON Schema assets.`,
);
