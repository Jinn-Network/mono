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

const { TaskSpecificationSchema } = await import("../dist/schemas/task.js");
const { SubmissionRecordSchema } = await import("../dist/schemas/submission.js");
const { DeliveryRecordSchema } = await import("../dist/schemas/delivery.js");
const { DispatchContextSchema } = await import("../dist/schemas/dispatch-context.js");
const { ProtocolObservationSchema } = await import("../dist/schemas/observation.js");

const FAMILIES = [
  ["task.schema.json", TaskSpecificationSchema],
  ["submission.schema.json", SubmissionRecordSchema],
  ["delivery.schema.json", DeliveryRecordSchema],
  ["dispatch-context.schema.json", DispatchContextSchema],
  ["observation.schema.json", ProtocolObservationSchema],
];

const assets = new Map();
for (const [filename, schema] of FAMILIES) {
  assets.set(filename, jsonBytes(z.toJSONSchema(schema, { target: "draft-2020-12" })));
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
