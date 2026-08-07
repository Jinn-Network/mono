/**
 * Library-to-CLI parity (BP-13, deliverable 4 / criterion 6): the M1 capability-parity proof
 * (spec §5.4 — "until M3 the CLI is the complete surface"). Every operation the facade
 * (`../operations/index.ts`) exports must be reachable through some CLI verb, and every CLI verb
 * must be backed by a real facade operation — neither surface may silently drift ahead of the
 * other. BP-14 formalizes this into a durable mechanism (`./parity-matrix.ts`,
 * `../../scripts/generate-parity-matrix.mjs`, `../../parity-matrix.v1.json`); this test remains
 * the runtime proof that fails loud the moment either surface drifts.
 *
 * `EXCLUDED_FACADE_EXPORTS` and `OPERATION_TO_VERB` now live in `./parity-map.ts` — the same
 * module BP-14's parity-matrix generator imports, so this test and that generator can never carry
 * two different copies of the same table. Check the facade's own header comments before adding to
 * `EXCLUDED_FACADE_EXPORTS`: an export belongs there only if it is NOT one of the "operations" the
 * facade's module doc describes itself as exposing.
 */

import { describe, expect, test } from "vitest";
import * as operations from "../operations/index.js";
import { CLI_VERB_NAMES } from "./main.js";
import { facadeOperationNames, OPERATION_TO_VERB, STANDALONE_CLI_VERBS } from "./parity-map.js";

describe("library-to-CLI parity (M1 capability-parity proof, spec §5.4)", () => {
  test("every non-excluded facade operation export has a verb-map entry, and that verb exists in CLI_VERB_NAMES", () => {
    const operationNames = facadeOperationNames(operations);
    expect(operationNames.length).toBeGreaterThan(0);

    for (const name of operationNames) {
      expect(OPERATION_TO_VERB, `facade export "${name}" has no entry in OPERATION_TO_VERB — add one, or add it to EXCLUDED_FACADE_EXPORTS if it is not an operation`).toHaveProperty(name);
      const verb = OPERATION_TO_VERB[name];
      expect(CLI_VERB_NAMES, `OPERATION_TO_VERB["${name}"] = "${verb}", but "${verb}" is not in CLI_VERB_NAMES — register it in main.ts's VERBS map`).toContain(verb);
    }
  });

  test("every OPERATION_TO_VERB entry names a real facade export (no stale map entries)", () => {
    const operationNames = new Set(facadeOperationNames(operations));
    for (const name of Object.keys(OPERATION_TO_VERB)) {
      expect(operationNames.has(name), `OPERATION_TO_VERB names "${name}", but the operations facade exports no such function`).toBe(true);
    }
  });

  test("every CLI verb is the target of some OPERATION_TO_VERB entry (no verb without a backing operation)", () => {
    const mappedVerbs = new Set([...Object.values(OPERATION_TO_VERB), ...Object.keys(STANDALONE_CLI_VERBS)]);
    for (const verb of CLI_VERB_NAMES) {
      expect(mappedVerbs.has(verb), `CLI verb "${verb}" is registered in main.ts's VERBS map but no OPERATION_TO_VERB entry targets it`).toBe(true);
    }
  });

  test("OPERATION_TO_VERB is exactly the size of the facade's own operation count (no duplicate verb targets)", () => {
    const operationNames = facadeOperationNames(operations);
    expect(Object.keys(OPERATION_TO_VERB)).toHaveLength(operationNames.length);
    expect(new Set(Object.values(OPERATION_TO_VERB)).size).toBe(Object.keys(OPERATION_TO_VERB).length);
  });
});
