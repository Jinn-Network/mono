/**
 * Library-to-CLI parity (BP-13, deliverable 4 / criterion 6): the M1 capability-parity proof
 * (spec §5.4 — "until M3 the CLI is the complete surface"). Every operation the facade
 * (`../operations/index.ts`) exports must be reachable through some CLI verb, and every CLI verb
 * must be backed by a real facade operation — neither surface may silently drift ahead of the
 * other. BP-14 formalizes this into a durable mechanism; this test is the stopgap that fails loud
 * in the meantime.
 *
 * `EXCLUDED_FACADE_EXPORTS` is the one hand-maintained escape hatch: facade exports that are
 * genuinely not operations (helpers re-exported for a sibling module to reuse, not surfaces a
 * caller invokes directly). Check the facade's own header comments before adding to it — an
 * export belongs here only if it is NOT one of the "operations" the facade's module doc describes
 * itself as exposing.
 */

import { describe, expect, test } from "vitest";
import * as operations from "../operations/index.js";
import { CLI_VERB_NAMES } from "./main.js";

/**
 * Facade exports that are helpers, not operations a caller invokes directly — see this file's own
 * header. Currently just one: `unverifiableAxisCounts` (`../operations/run-results.ts`) is
 * exported so `../report/claim.ts` can reuse the same per-axis tally the results document builds;
 * it is not itself an operation with an `OperationContext`/`OperationResult` shape.
 */
const EXCLUDED_FACADE_EXPORTS: readonly string[] = ["unverifiableAxisCounts"];

/**
 * The explicit operation -> verb map. A future facade operation with no entry here (or a verb
 * with no operation behind it) is exactly the drift this test exists to catch — the fix is always
 * to add the missing counterpart, never to loosen this test.
 */
const OPERATION_TO_VERB: Readonly<Record<string, string>> = {
  initWorkspace: "init",
  createDraft: "draft create",
  getDraft: "draft show",
  listDrafts: "draft list",
  updateDraft: "draft update",
  inspectDraft: "inspect",
  sampleInit: "sample init",
  importSweBenchRows: "import swebench",
  armAdd: "arm add",
  armUpdate: "arm update",
  armRemove: "arm remove",
  armList: "arm list",
  authorityGrant: "authority grant",
  authorityRevoke: "authority revoke",
  authorityShow: "authority show",
  runQuote: "quote",
  runLock: "lock",
  runLaunch: "launch",
  runResume: "resume",
  runStatus: "status",
  runCollect: "collect",
  runResults: "results",
  runReport: "report",
  runVerify: "verify",
};

function facadeOperationNames(): string[] {
  return Object.keys(operations)
    .filter((name) => typeof (operations as Record<string, unknown>)[name] === "function")
    .filter((name) => !EXCLUDED_FACADE_EXPORTS.includes(name));
}

describe("library-to-CLI parity (M1 capability-parity proof, spec §5.4)", () => {
  test("every non-excluded facade operation export has a verb-map entry, and that verb exists in CLI_VERB_NAMES", () => {
    const operationNames = facadeOperationNames();
    expect(operationNames.length).toBeGreaterThan(0);

    for (const name of operationNames) {
      expect(OPERATION_TO_VERB, `facade export "${name}" has no entry in OPERATION_TO_VERB — add one, or add it to EXCLUDED_FACADE_EXPORTS if it is not an operation`).toHaveProperty(name);
      const verb = OPERATION_TO_VERB[name];
      expect(CLI_VERB_NAMES, `OPERATION_TO_VERB["${name}"] = "${verb}", but "${verb}" is not in CLI_VERB_NAMES — register it in main.ts's VERBS map`).toContain(verb);
    }
  });

  test("every OPERATION_TO_VERB entry names a real facade export (no stale map entries)", () => {
    const operationNames = new Set(facadeOperationNames());
    for (const name of Object.keys(OPERATION_TO_VERB)) {
      expect(operationNames.has(name), `OPERATION_TO_VERB names "${name}", but the operations facade exports no such function`).toBe(true);
    }
  });

  test("every CLI verb is the target of some OPERATION_TO_VERB entry (no verb without a backing operation)", () => {
    const mappedVerbs = new Set(Object.values(OPERATION_TO_VERB));
    for (const verb of CLI_VERB_NAMES) {
      expect(mappedVerbs.has(verb), `CLI verb "${verb}" is registered in main.ts's VERBS map but no OPERATION_TO_VERB entry targets it`).toBe(true);
    }
  });

  test("OPERATION_TO_VERB is exactly the size of the facade's own operation count (no duplicate verb targets)", () => {
    const operationNames = facadeOperationNames();
    expect(Object.keys(OPERATION_TO_VERB)).toHaveLength(operationNames.length);
    expect(new Set(Object.values(OPERATION_TO_VERB)).size).toBe(Object.keys(OPERATION_TO_VERB).length);
  });
});
