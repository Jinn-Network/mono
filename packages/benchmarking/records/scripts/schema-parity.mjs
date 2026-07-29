import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { isCalendarStrictRfc3339 } from "../dist/rfc3339.js";

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

for (const family of ["benchmark", "run", "matrix", "report"]) {
  const check = await validate(family);
  const fixture = await readJson(join(fixtures, family, "minimal.json"));
  assert(check(fixture), `${family} minimal fixture failed Draft 2020-12 parity: ${JSON.stringify(check.errors)}`);
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

const matrix = await readJson(join(fixtures, "matrix", "minimal.json"));
const matrixCheck = await validate("matrix");
matrix.aggregates = {};
assert(!matrixCheck(matrix), "unnamespaced Matrix aggregate must fail schema parity");

console.log("Draft 2020-12 schema parity: 4 fixtures + leap/invalid-date/floor/aggregate vectors passed.");
