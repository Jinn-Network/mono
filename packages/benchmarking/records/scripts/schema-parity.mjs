import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { isCalendarStrictRfc3339 } from "../dist/rfc3339.js";
import { BenchmarkRecordSchema } from "../dist/benchmark/schema.js";
import { RunRecordSchema } from "../dist/run/schema.js";
import { MatrixRecordSchema } from "../dist/matrix/schema.js";
import { ReportRecordSchema } from "../dist/report/schema.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemas = join(root, "schemas");
const fixtures = join(root, "fixtures");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const validate = async (family) => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("date-time", { type: "string", validate: isCalendarStrictRfc3339 });
  return ajv.compile(await readJson(join(schemas, `${family}.schema.json`)));
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const runtimeSchemas = { benchmark: BenchmarkRecordSchema, run: RunRecordSchema, matrix: MatrixRecordSchema, report: ReportRecordSchema };
const corpus = {
  benchmark: { valid: ["minimal", "valid"], invalid: ["invalid-bad-version", "invalid-item-uri-only"] },
  run: { valid: ["minimal", "valid"], invalid: ["invalid-benchmark-uri-only", "invalid-missing-closeAt"] },
  matrix: { valid: ["minimal", "valid"], invalid: ["invalid-aggregate-field", "invalid-bad-outcome", "invalid-run-uri-only"] },
  report: { valid: ["minimal", "plural-valid", "valid"], invalid: ["invalid-missing-disclosures", "invalid-subject-uri-only"] },
};

async function assertParity(kind, fixture, expected) {
  const document = await readJson(join(fixtures, kind, `${fixture}.json`));
  const schema = await validate(kind);
  const runtimeOk = runtimeSchemas[kind].safeParse(document).success;
  const schemaOk = schema(document);
  const diagnostic = `${kind}/${fixture}`;
  assert(runtimeOk === expected, `${diagnostic}: runtime ${runtimeOk ? "accepted" : "rejected"} fixture contrary to corpus expectation`);
  assert(schemaOk === expected, `${diagnostic}: Draft 2020-12 ${schemaOk ? "accepted" : "rejected"} fixture contrary to corpus expectation: ${JSON.stringify(schema.errors)}`);
  assert(runtimeOk === schemaOk, `${diagnostic}: runtime=${runtimeOk} Draft-2020-12=${schemaOk}: ${JSON.stringify(schema.errors)}`);
}

for (const [kind, families] of Object.entries(corpus)) {
  for (const fixture of families.valid) await assertParity(kind, fixture, true);
  for (const fixture of families.invalid) await assertParity(kind, fixture, false);
}

const run = await readJson(join(fixtures, "run", "minimal.json"));
const runCheck = await validate("run");
run.closeAt = "2016-12-31T23:59:60Z";
assert(runCheck(run), "valid leap second must pass schema parity");
run.closeAt = "2026-02-30T00:00:00Z";
assert(!runCheck(run), "impossible civil date must fail schema parity");
run.closeAt = "2016-12-31T23:59:60Z";
run.policy.completenessFloor = "0." + "0".repeat(400) + "1";
assert(runCheck(run), "arbitrarily tiny positive floor must pass schema parity");
run.policy.completenessFloor = "1.0000000000000000001";
assert(!runCheck(run), "above-one floor must fail schema parity");

const matrix = await readJson(join(fixtures, "matrix", "valid.json"));
const matrixCheck = await validate("matrix");
matrix.aggregates = {};
assert(!matrixCheck(matrix), "unnamespaced Matrix aggregate must fail schema parity");
delete matrix.aggregates;

for (const armId of ["1arm", "_arm", "-arm", "__proto__", "constructor", "prototype"]) {
  matrix.cells[0].armId = armId;
  matrix.cells[0].cellKey = `${matrix.cells[0].taskDigest}/${armId}/1`;
  matrix.attrition.perArm = { [armId]: {
    expected: 1, judged: 1, unjudged: 0, unscorable: 0, expired: 0,
    invalidated: 0, excluded: 0, replacements: 0,
  } };
  const runtime = MatrixRecordSchema.safeParse(matrix);
  const runtimeOk = runtime.success;
  const schemaOk = matrixCheck(matrix);
  assert(runtimeOk && schemaOk, `matrix/perArm/${armId}: runtime=${runtimeOk} Draft-2020-12=${schemaOk}: ${JSON.stringify(runtime.error?.issues ?? matrixCheck.errors)}`);
}
for (const armId of ["", "dot.arm", "a".repeat(65), "space arm", "slash/arm"]) {
  matrix.cells[0].armId = armId;
  matrix.cells[0].cellKey = `${matrix.cells[0].taskDigest}/${armId}/1`;
  matrix.attrition.perArm = { [armId]: {
    expected: 0, judged: 0, unjudged: 0, unscorable: 0, expired: 0,
    invalidated: 0, excluded: 0, replacements: 0,
  } };
  const runtime = MatrixRecordSchema.safeParse(matrix);
  const runtimeOk = runtime.success;
  const schemaOk = matrixCheck(matrix);
  assert(!runtimeOk && !schemaOk, `matrix/perArm/${JSON.stringify(armId)}: runtime and Draft 2020-12 must reject an invalid Arm ID`);
}
matrix.attrition.perArm = {};

const extension = await readJson(join(fixtures, "benchmark", "minimal.json"));
extension["urn:jinn:benchmarking:extension"] = { opaque: true };
const benchmarkCheck = await validate("benchmark");
assert(BenchmarkRecordSchema.safeParse(extension).success && benchmarkCheck(extension), "benchmark/urn-extension: runtime and Draft 2020-12 must accept a valid urn: extension key");

const descriptorName = await readJson(join(fixtures, "run", "minimal.json"));
descriptorName.benchmark.name = "sealed Benchmark acquisition hint";
assert(RunRecordSchema.safeParse(descriptorName).success && runCheck(descriptorName), "run/digest-descriptor-name: runtime and Draft 2020-12 must accept optional ResourceDescriptor name");

const leadingDigitArm = await readJson(join(fixtures, "run", "minimal.json"));
leadingDigitArm.arms[0].armId = "1arm";
assert(RunRecordSchema.safeParse(leadingDigitArm).success && runCheck(leadingDigitArm), "run/leading-digit-arm: runtime and Draft 2020-12 must accept armId 1arm");

console.log("Draft 2020-12 schema parity: bidirectional corpus + extension/descriptor/arm/time/floor/aggregate vectors passed.");
