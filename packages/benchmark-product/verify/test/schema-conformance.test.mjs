// The published JSON Schemas under schemas/ are transcriptions of the Zod
// definitions the verifier enforces. These tests pin them against the
// conformance kit so they cannot drift from the shipped wire formats: every
// golden document must validate, the discriminator literals must match the
// bytes the current producer emits (the golden is proven current by the
// reference verifier), and schema validity must never be mistaken for
// verification.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

const schemasDir = fileURLToPath(new URL("../schemas", import.meta.url));
const kit = fileURLToPath(new URL("../fixtures/public-bundle-conformance-v1", import.meta.url));
const golden = join(kit, "golden");

// Formats stay annotations (2020-12 default); canonical-byte and digest rules
// are the verifier's job, not the schema's. allowUnionTypes and strictRequired
// admit two valid 2020-12 constructs ajv's strict mode is opinionated about
// (union-typed measurements; the headline-or-comparison anyOf).
const ajv = new Ajv2020({
  strict: true,
  strictRequired: false,
  allowUnionTypes: true,
  validateFormats: false,
  allErrors: true,
});

const loadSchema = (name) => JSON.parse(readFileSync(join(schemasDir, name), "utf8"));
const loadGolden = (rel) => JSON.parse(readFileSync(join(golden, rel), "utf8"));

const PAIRS = [
  ["bundle-manifest.schema.json", "bundle.json"],
  ["evidence-catalog.schema.json", "evidence.json"],
  ["verdict-catalog.schema.json", "verdicts.json"],
  ["public-trust.schema.json", "trust/public-keys.json"],
  ["claim-package.schema.json", "claim-package.json"],
  ["dsse-envelope.schema.json", "report-envelope.json"],
];

for (const [schemaFile, docFile] of PAIRS) {
  test(`golden ${docFile} validates against ${schemaFile}`, () => {
    const validate = ajv.compile(loadSchema(schemaFile));
    assert.equal(validate(loadGolden(docFile)), true, JSON.stringify(validate.errors, null, 1));
  });
}

test("every golden verdict record validates as a DSSE envelope", () => {
  const validate = ajv.compile(loadSchema("dsse-envelope.schema.json"));
  for (const verdict of loadGolden("verdicts.json").verdicts) {
    const envelope = JSON.parse(readFileSync(join(golden, "records", `${verdict.sha256}.bin`), "utf8"));
    assert.equal(validate(envelope), true, JSON.stringify(validate.errors, null, 1));
  }
});

test("every golden assembly row validates against assembly-row.schema.json", () => {
  const validate = ajv.compile(loadSchema("assembly-row.schema.json"));
  const rows = readFileSync(join(golden, "verification", "assembly.jsonl"), "utf8").trimEnd().split("\n");
  assert.ok(rows.length >= 2, "assembly must carry a header and at least one cell");
  for (const row of rows) {
    assert.equal(validate(JSON.parse(row)), true, JSON.stringify(validate.errors, null, 1));
  }
});

test("schema discriminators match the literals the current producer emits", () => {
  assert.equal(loadSchema("bundle-manifest.schema.json").properties.format.const, loadGolden("bundle.json").format);
  assert.equal(loadSchema("evidence-catalog.schema.json").properties.format.const, loadGolden("evidence.json").format);
  assert.equal(loadSchema("verdict-catalog.schema.json").properties.format.const, loadGolden("verdicts.json").format);
  assert.equal(loadSchema("public-trust.schema.json").properties.format.const, loadGolden("trust/public-keys.json").format);
  assert.ok(loadSchema("claim-package.schema.json").properties.claimSchema.enum.includes(loadGolden("claim-package.json").claimSchema));
  const headerRow = JSON.parse(readFileSync(join(golden, "verification", "assembly.jsonl"), "utf8").split("\n")[0]);
  assert.equal(loadSchema("assembly-row.schema.json").$defs.header.properties.format.const, headerRow.format);
});

test("schema validity does not imply verification: a key-swapped trust file still validates", () => {
  const validate = ajv.compile(loadSchema("public-trust.schema.json"));
  const tamperedTrust = JSON.parse(
    readFileSync(join(kit, "tampered", "trust-key-swapped", "trust", "public-keys.json"), "utf8"),
  );
  assert.equal(validate(tamperedTrust), true, "structural schemas must not overclaim: this file fails the trust check, not the schema");
});

test("the schemas ship in the npm tarball", () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  assert.ok(manifest.files.includes("schemas/"), "package.json files must include schemas/");
});
