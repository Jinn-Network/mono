import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { isCalendarStrictRfc3339 } from "../dist/rfc3339.js";
import { BenchmarkRecordSchema } from "../dist/benchmark/schema.js";
import { RunRecordSchema } from "../dist/run/schema.js";
import { MatrixRecordSchema } from "../dist/matrix/schema.js";
import { ReportRecordSchema } from "../dist/report/schema.js";
import { BenchmarkAccountingRecordSchema, ObservationArchiveSchema } from "../dist/accounting/schema.js";

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

const runtimeSchemas = {
  benchmark: BenchmarkRecordSchema,
  run: RunRecordSchema,
  matrix: MatrixRecordSchema,
  report: ReportRecordSchema,
  "benchmark-accounting": BenchmarkAccountingRecordSchema,
  "observation-archive": ObservationArchiveSchema,
};
const corpus = {
  benchmark: { valid: ["minimal", "valid"], invalid: ["invalid-bad-version", "invalid-item-uri-only"] },
  run: { valid: ["minimal", "valid"], invalid: ["invalid-benchmark-uri-only", "invalid-missing-closeAt"] },
  matrix: { valid: ["minimal", "valid"], invalid: ["invalid-aggregate-field", "invalid-bad-outcome", "invalid-run-uri-only"] },
  report: { valid: ["minimal", "plural-valid", "valid"], invalid: ["invalid-missing-disclosures", "invalid-subject-uri-only"] },
  "benchmark-accounting": { valid: ["valid"], invalid: ["invalid-missing-protocol", "invalid-missing-publisher-authority"] },
  "observation-archive": { valid: ["valid"], invalid: ["invalid-missing-profile"] },
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

const accountingAfterClose = await readJson(join(fixtures, "benchmark-accounting", "invalid-authorization-after-close.json"));
const accountingCheck = await validate("benchmark-accounting");
assert(!BenchmarkAccountingRecordSchema.safeParse(accountingAfterClose).success, "benchmark-accounting/authorization-after-close: runtime must reject delegate authority effective after close");
assert(accountingCheck(accountingAfterClose), "benchmark-accounting/authorization-after-close: Draft 2020-12 accepts shape (instant ordering is runtime-only)");

const observationArchive = await readJson(join(fixtures, "observation-archive", "valid.json"));
const observationArchiveCheck = await validate("observation-archive");
observationArchive.streams[0].observations = [{}];
assert(!ObservationArchiveSchema.safeParse(observationArchive).success, "observation-archive/empty-observation: runtime must reject an empty observation object");
assert(!observationArchiveCheck(observationArchive), "observation-archive/empty-observation: Draft 2020-12 must reject an empty observation object");

const observationArchiveConflict = await readJson(join(fixtures, "observation-archive", "valid.json"));
observationArchiveConflict.streams[0].observations = [];
observationArchiveConflict.streams[0].conflicts = [{
  source: observationArchiveConflict.streams[0].source,
  id: "conflict",
  observations: [{}, {}],
}];
assert(!ObservationArchiveSchema.safeParse(observationArchiveConflict).success, "observation-archive/empty-conflict-observation: runtime must reject empty conflict observations");
assert(!observationArchiveCheck(observationArchiveConflict), "observation-archive/empty-conflict-observation: Draft 2020-12 must reject empty conflict observations");

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

const reportHostile = await readJson(join(fixtures, "report", "minimal.json"));
const reportCheck = await validate("report");
reportHostile.disclosures.perSubject[0].completeness = { expected: 0, judged: 0, floor: "1", runOutcome: "complete" };
assert(!ReportRecordSchema.safeParse(reportHostile).success, "report/zero-expected-complete: runtime must reject complete at zero eligible denominator");
assert(reportCheck(reportHostile), "report/zero-expected-complete: Draft 2020-12 accepts shape (semantic gate is runtime-only)");
reportHostile.disclosures.perSubject[0].completeness.runOutcome = "partial";
assert(ReportRecordSchema.safeParse(reportHostile).success && reportCheck(reportHostile), "report/zero-expected-partial: runtime and Draft 2020-12 must accept partial at zero eligible denominator");

const reportAllExcluded = await readJson(join(fixtures, "report", "valid.json"));
reportAllExcluded.disclosures.perSubject[0].attrition.perArm.armA = {
  expected: 1, judged: 0, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 1, replacements: 0,
};
reportAllExcluded.disclosures.perSubject[0].completeness = { expected: 1, judged: 0, floor: "1", runOutcome: "complete" };
assert(!ReportRecordSchema.safeParse(reportAllExcluded).success, "report/all-excluded-complete: runtime must reject complete when every cell is excluded");
assert(reportCheck(reportAllExcluded), "report/all-excluded-complete: Draft 2020-12 accepts shape (semantic gate is runtime-only)");
reportAllExcluded.disclosures.perSubject[0].completeness.runOutcome = "partial";
assert(ReportRecordSchema.safeParse(reportAllExcluded).success && reportCheck(reportAllExcluded), "report/all-excluded-partial: runtime and Draft 2020-12 must accept partial when every cell is excluded");

const reportSchemaDoc = await readJson(join(schemas, "report.schema.json"));
const reportCompleteness = reportSchemaDoc.properties.disclosures.properties.perSubject.items.properties.completeness;
assert(
  reportCompleteness.$comment === "Runtime check: per-subject completeness partition (expected, judged, attrition excluded) and runOutcome floor pairing (§8.1, §9.1).",
  "report/disclosures/perSubject/completeness must document runtime-only partition validation",
);
assert(
  reportCompleteness.properties.floor.$comment === "Runtime check: exact BigInt completeness comparison and outcome derivation.",
  "report/disclosures/perSubject/completeness.floor must document runtime-only decimal comparison",
);
assert(
  reportSchemaDoc.$comment === "Runtime checks: cross-record references, canonical byte equality, and Report cross-field invariants.",
  "report top-level comment must name Report invariants only",
);

const partitionHostile = await readJson(join(fixtures, "report", "minimal.json"));
partitionHostile.disclosures.perSubject[0].attrition = {
  perArm: {
    armA: {
      expected: 4, judged: 4, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 2, replacements: 0,
    },
  },
  asymmetryFlags: [],
};
partitionHostile.disclosures.perSubject[0].completeness = { expected: 4, judged: 4, floor: "1", runOutcome: "complete" };
assert(!ReportRecordSchema.safeParse(partitionHostile).success, "report/partition-judged-overflow: runtime must reject judged above eligible");
assert(reportCheck(partitionHostile), "report/partition-judged-overflow: Draft 2020-12 accepts shape (semantic gate is runtime-only)");

const excludedOverflow = await readJson(join(fixtures, "report", "minimal.json"));
excludedOverflow.disclosures.perSubject[0].attrition = {
  perArm: {
    armA: {
      expected: 2, judged: 0, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 2, replacements: 0,
    },
    armB: {
      expected: 1, judged: 0, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 1, replacements: 0,
    },
  },
  asymmetryFlags: [],
};
excludedOverflow.disclosures.perSubject[0].completeness = { expected: 2, judged: 0, floor: "1", runOutcome: "partial" };
assert(!ReportRecordSchema.safeParse(excludedOverflow).success, "report/partition-excluded-overflow: runtime must reject excluded above expected");
assert(reportCheck(excludedOverflow), "report/partition-excluded-overflow: Draft 2020-12 accepts shape (semantic gate is runtime-only)");

const partitionEdge = await readJson(join(fixtures, "report", "minimal.json"));
partitionEdge.disclosures.perSubject[0].attrition = {
  perArm: {
    armA: {
      expected: 2, judged: 2, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 0, replacements: 0,
    },
  },
  asymmetryFlags: [],
};
partitionEdge.disclosures.perSubject[0].completeness = { expected: 2, judged: 2, floor: "1", runOutcome: "complete" };
assert(ReportRecordSchema.safeParse(partitionEdge).success && reportCheck(partitionEdge), "report/partition-judged-equals-eligible: runtime and Draft 2020-12 must accept the edge");

console.log("Draft 2020-12 schema parity: bidirectional corpus + extension/descriptor/arm/time/floor/aggregate vectors passed.");
