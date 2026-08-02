import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const evaluatorRoot = new URL("../../src/evaluator/", import.meta.url);
const harvestedModules = [
  "self-evaluation.ts",
  "opportunities.ts",
  "subject-material.ts",
  "verdict-gate.ts",
  "deployment.ts",
];
const forbiddenImports: ReadonlyArray<[string, RegExp]> = [
  ["bridge", /from\s+["'][^"']*bridge[^"']*["']/iu],
  ["legacy runtime", /from\s+["'][^"']*(?:legacy-task|task-engine|watcher)[^"']*["']/iu],
  ["self-signer grant", /(?:signer-resolver|capabilityGrant|capability-grant)/iu],
  ["ephemeral key", /(?:ephemeral[-_ ]?key|randomUUID|generateKeyPair)/iu],
  ["in-memory intent", /(?:createInMemory|in-memory.*intent)/iu],
  ["fake trust or evidence", /(?:fake(?:Trust|Evidence)|all-zero|zeroEvidence)/iu],
];

function findForbiddenNativeDependencies(source: string): string[] {
  return forbiddenImports
    .filter(([, pattern]) => pattern.test(source))
    .map(([label]) => label);
}

describe("harvested evaluator primitive architecture", () => {
  it("has no bridge, legacy runtime, signer grant, ephemeral key, in-memory intent, or fake trust/evidence dependency", () => {
    const offenders = harvestedModules.flatMap((name) => {
      const source = readFileSync(fileURLToPath(new URL(name, evaluatorRoot)), "utf8");
      return findForbiddenNativeDependencies(source).map((label) => `${name}: ${label}`);
    });

    expect(offenders).toEqual([]);
  });

  it("canary: detects every prohibited dependency family", () => {
    expect(findForbiddenNativeDependencies([
      "import value from './bridge/legacy-task.js';",
      "import value from './legacy-task-engine.js';",
      "const key = capabilityGrant;",
      "const key = generateKeyPair();",
      "const intents = createInMemoryIntentStore();",
      "const evidence = fakeEvidence;",
    ].join("\n"))).toEqual([
      "bridge",
      "legacy runtime",
      "self-signer grant",
      "ephemeral key",
      "in-memory intent",
      "fake trust or evidence",
    ]);
  });
});
