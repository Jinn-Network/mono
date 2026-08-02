import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const harvestedModules = [
  ["self-evaluation", new URL("../../src/evaluator/self-evaluation.ts", import.meta.url)],
  ["opportunities", new URL("../../src/evaluator/opportunities.ts", import.meta.url)],
  ["subject-material", new URL("../../src/evaluator/subject-material.ts", import.meta.url)],
  ["verdict-gate", new URL("../../src/evaluator/verdict-gate.ts", import.meta.url)],
  ["client deployment", new URL("../../src/evaluator/deployment.ts", import.meta.url)],
  ["venue verdict", new URL("../../../packages/marketplace/venue-base/src/verdict.ts", import.meta.url)],
  [
    "evaluator-adapters deployment",
    new URL("../../../packages/task-execution/evaluator-adapters/src/deployment.ts", import.meta.url),
  ],
];
const forbiddenImports: ReadonlyArray<[string, RegExp]> = [
  ["bridge", /from\s+["'][^"']*bridge[^"']*["']/iu],
  ["legacy runtime", /from\s+["'][^"']*(?:legacy-task|task-engine|watcher)[^"']*["']/iu],
  ["self-signer grant", /(?:signer-resolver|capabilityGrant|capability-grant)/iu],
  ["ephemeral key", /(?:ephemeral[-_ ]?key|randomUUID|generateKeyPair)/iu],
  ["in-memory intent", /(?:createInMemory|in-memory.*intent)/iu],
  ["no-op runtime", /(?:no[-_ ]?op(?:[-_ ]?runtime)?|noop|createNoop|disabled[-_ ]?runtime)/iu],
  ["permissive trust", /(?:permissive[-_ ]?trust|allowAllTrust|acceptAllTrust|alwaysTrust)/iu],
  ["fake trust or evidence", /(?:fake(?:Trust|Evidence)|all-zero|zeroEvidence)/iu],
];

function findForbiddenNativeDependencies(source: string): string[] {
  return forbiddenImports
    .filter(([, pattern]) => pattern.test(source))
    .map(([label]) => label);
}

describe("harvested evaluator primitive architecture", () => {
  it("has no bridge, legacy runtime, signer grant, ephemeral key, in-memory intent, or fake trust/evidence dependency", () => {
    const offenders = harvestedModules.flatMap(([name, url]) => {
      const source = readFileSync(fileURLToPath(url), "utf8");
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
      "const runtime = createNoopRuntime();",
      "const trust = allowAllTrust;",
      "const evidence = fakeEvidence;",
    ].join("\n"))).toEqual([
      "bridge",
      "legacy runtime",
      "self-signer grant",
      "ephemeral key",
      "in-memory intent",
      "no-op runtime",
      "permissive trust",
      "fake trust or evidence",
    ]);
  });
});
