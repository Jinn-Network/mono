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
