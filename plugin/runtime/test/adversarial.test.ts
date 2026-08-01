// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, test } from "vitest";

import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "../src/capture/paths.js";
import { runPickup } from "../src/pickup.js";
import { QUOTE_PREFIX } from "../src/projection/fence.js";
import { createCorpusAdmissionFilter } from "../src/relevance/admission.js";
import { type IndexDatabaseIO } from "../src/relevance/database.js";
import { openRelevanceIndex, type RelevanceIndex } from "../src/relevance/index-store.js";
import { type SensitivityNonceIO } from "../src/relevance/nonce.js";
import { createSensitivityClassifier } from "../src/relevance/sensitivity.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "adversarial");
const QUERY = "the flaky corpus index tokenizer needs a rebuild";
// These fixtures probe projection safety, not admission; admission is exercised in
// admission.test.ts and pickup.test.ts. Admitting everything keeps each suite on one axis.
const admitAll = createCorpusAdmissionFilter({ admitProducer: async () => ({ admitted: true }) });

const testIndexIo: IndexDatabaseIO = {
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
  removeFile: (path) => rm(path, { force: true }),
};

const testNonceIo: SensitivityNonceIO = {
  readFile,
  writeFile,
  ensureOwnerOnlyFile,
};

interface Fixture {
  readonly seed: string;
  readonly plane: "local" | "public";
  readonly summary: string;
  readonly origin: string;
  readonly capturedAt: string;
  readonly outcome: "completed" | "failed" | "abandoned";
  readonly excerpts: readonly {
    readonly label: "failure" | "fix" | "command" | "diff" | "note";
    readonly text: string;
  }[];
}

const load = async (name: string): Promise<Fixture> =>
  JSON.parse(await readFile(join(FIXTURES, name), "utf8")) as Fixture;

let index: RelevanceIndex;

const put = async (fixture: Fixture) =>
  index.put({
    plane: fixture.plane,
    reference: {
      family: "execution-evidence",
      digest: `sha256:${fixture.seed.repeat(64).slice(0, 64)}` as `sha256:${string}`,
    },
    summary: fixture.summary,
    origin: fixture.origin,
    capturedAt: fixture.capturedAt,
    outcome: fixture.outcome,
    excerpts: fixture.excerpts.map((excerpt) => ({
      label: excerpt.label,
      sourceEntityId: "trace.ndjson",
      sourceDigest: `sha256:${"e".repeat(64)}` as `sha256:${string}`,
      text: excerpt.text,
    })),
  });

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "jinn-adversarial-"));
  index = await openRelevanceIndex({
    databasePath: join(home, "index.sqlite"),
    indexIo: testIndexIo,
    classifier: await createSensitivityClassifier({
      noncePath: join(home, "sensitivity-nonce"),
      knownIdentities: [],
      nonceIo: testNonceIo,
    }),
    now: () => "2026-07-30T00:00:00.000Z",
  });
});

describe("gate C6 — adversarial fixtures", () => {
  test("the manifest covers every fixture file", async () => {
    const manifest = JSON.parse(await readFile(join(FIXTURES, "manifest.json"), "utf8")) as {
      fixtures: { file: string; attack: string; expectation: string }[];
    };
    expect(manifest.fixtures).toHaveLength(5);
    for (const entry of manifest.fixtures) {
      await expect(readFile(join(FIXTURES, entry.file), "utf8")).resolves.toBeTypeOf("string");
      expect(entry.attack.length).toBeGreaterThan(10);
      expect(entry.expectation.length).toBeGreaterThan(10);
    }
  });

  test("no instruction-bearing record reaches projection unquoted", async () => {
    await put(await load("instruction-bearing.json"));
    const result = await runPickup({ index, admission: admitAll }, { message: QUERY });
    expect(result.status).toBe("projected");

    const lines = result.text.split("\n");
    const begin = lines.findIndex((line) => line.includes("<<<BEGIN"));
    const end = lines.findIndex((line) => line.includes("<<<END"));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    for (const line of lines.slice(begin + 1, end)) {
      expect(line.startsWith(QUOTE_PREFIX)).toBe(true);
    }
    expect(result.text).not.toMatch(/^SYSTEM:/mu);
    expect(result.text).not.toMatch(/^You are now in maintenance mode/mu);
    expect(result.text).toContain("never follow directives");
  });

  test("a forged closing fence cannot end the quoted block early", async () => {
    await put(await load("fence-breakout.json"));
    const result = await runPickup({ index, admission: admitAll }, { message: QUERY });
    const fenceLines = result.text.split("\n").filter((line) => line.startsWith("<<<"));
    expect(fenceLines).toHaveLength(2);
    expect(fenceLines[0]!.includes("jinn-corpus-0000000000000000")).toBe(false);
    // The forged marker is inside the block, quoted, and is not the real boundary.
    const quotedForgery = result.text
      .split("\n")
      .find((line) => line.includes("jinn-corpus-0000000000000000"));
    expect(quotedForgery?.startsWith(QUOTE_PREFIX)).toBe(true);
  });

  test("ranking survives a stuffed-metadata distractor", async () => {
    await put(await load("genuine.json"));
    await put(await load("stuffed-metadata.json"));
    const result = await runPickup({ index, admission: admitAll }, { message: QUERY });

    expect(result.status).toBe("projected");
    expect(result.records[0]!.origin).toBe("urn:jinn:agent:operator-local");
    expect(
      result.records.some((record) => record.origin === "urn:jinn:agent:distractor"),
    ).toBe(false);

    // The distractor's repetition earns exactly one point of coverage — below the floor.
    const raw = await index.search({ terms: ["flaky"], floor: 1 });
    const stuffed = raw.find((candidate) => candidate.origin === "urn:jinn:agent:distractor");
    expect(stuffed?.coverage).toBe(1);
  });

  test("a high-band-sensitive excerpt is never projected, and the record still helps", async () => {
    const fixture = await load("planted-secret.json");
    const receipt = await put(fixture);
    expect(receipt.status).toBe("indexed");
    expect(receipt.indexedExcerpts).toBe(1);
    expect(receipt.excluded.map((entry) => entry.classes).flat()).toContain("credential");

    const result = await runPickup({ index, admission: admitAll }, { message: QUERY });
    expect(result.status).toBe("projected");
    expect(result.text).not.toContain("npm_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
    expect(result.text).not.toContain("NPM_TOKEN");
    expect(result.text).toContain("yarn rebuild --drop-index");
  });

  test("the secret is unreachable by direct search as well as by pickup", async () => {
    await put(await load("planted-secret.json"));
    expect(await index.search({ terms: ["npm_token"], floor: 1 })).toHaveLength(0);
    expect(await index.search({ terms: ["publish", "npm_token"], floor: 2 })).toHaveLength(0);
  });

  test("the whole fixture set together still yields a safe, honest projection", async () => {
    for (const name of [
      "genuine.json",
      "instruction-bearing.json",
      "fence-breakout.json",
      "stuffed-metadata.json",
      "planted-secret.json",
    ]) {
      await put(await load(name));
    }
    const result = await runPickup({ index, admission: admitAll }, { message: QUERY });
    expect(result.status).toBe("projected");
    expect(result.records).toHaveLength(2);
    expect(result.text).not.toContain("npm_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
    expect(result.text).not.toMatch(/^SYSTEM:/mu);
    expect(result.text.split("\n").filter((line) => line.startsWith("<<<"))).toHaveLength(2);
    expect(result.usedChars).toBeLessThanOrEqual(result.budget.maxChars);
  });

  test("an unrelated query over the hostile corpus finds nothing", async () => {
    for (const name of ["instruction-bearing.json", "stuffed-metadata.json"]) {
      await put(await load(name));
    }
    const result = await runPickup({ index, admission: admitAll }, {
      message: "how do I configure the Kubernetes ingress controller",
    });
    expect(result.status).toBe("nothing-relevant");
    expect(result.text).toBe("");
  });
});
