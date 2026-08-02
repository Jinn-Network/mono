import {
  CHAIN_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_KIND,
  prefixedDigest,
  sealChainEnvironmentRecord,
  sealCryptoEnvironmentRecord,
} from "@jinn-network/chain-environment-record";
import { recordDigest } from "@jinn-network/record-discovery-protocol";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { INFORMATION_WORLD_KIND } from "./identifiers.js";
import {
  CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE,
  chainEnvironmentRecompute,
  cryptoEnvironmentRecompute,
  informationWorldRecompute,
} from "./recompute.js";

const noReferences = { fetch: async () => undefined };

/** The record packages' own goldens are the inputs, so the leaf can never drift from the kind. */
const goldenJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(
      new URL(import.meta.resolve(`@jinn-network/chain-environment-record/fixtures/${path}`)),
      "utf8",
    ),
  ) as Record<string, unknown>;

const loadInformationWorldGolden = (): Promise<Uint8Array> =>
  readFile(new URL(import.meta.resolve("@jinn-network/information-world/fixtures/world/synthetic.json")));

describe("chain-environment record-fact recompute", () => {
  it("recomputes every fact from the record's own sealed bytes", async () => {
    const document = await goldenJson("chain/closed-anchored-subset.json");
    const bytes = sealChainEnvironmentRecord(document);
    const state = document.stateMaterialization as {
      stateArtifact: { descriptor: { digest: { sha256: string } } };
      closureClass: string;
      fidelityClass: string;
    };
    const runtime = document.runtime as { family: string; version: string; image: { manifestDigest: string } };
    expect(await chainEnvironmentRecompute(bytes, noReferences)).toEqual({
      chainEnvironmentRecordDigest: recordDigest(bytes),
      "runtime.family": runtime.family,
      "runtime.version": runtime.version,
      "runtime.image.manifestDigest": runtime.image.manifestDigest,
      "stateMaterialization.closureClass": state.closureClass,
      "stateMaterialization.fidelityClass": state.fidelityClass,
      "stateMaterialization.stateArtifactDigest": prefixedDigest(state.stateArtifact.descriptor.digest.sha256),
    });
  });

  it("omits the artifact fact for a record that has no state artifact yet", async () => {
    const bytes = sealChainEnvironmentRecord(await goldenJson("chain/archive-dependent.json"));
    const facts = await chainEnvironmentRecompute(bytes, noReferences);
    expect(Object.hasOwn(facts, "stateMaterialization.stateArtifactDigest")).toBe(false);
    expect(facts["stateMaterialization.closureClass"]).toBe("archive-dependent");
  });

  it("emits the artifact digest in the record-body spelling, not the DigestSet spelling", async () => {
    const bytes = sealChainEnvironmentRecord(await goldenJson("chain/closed-local.json"));
    const facts = await chainEnvironmentRecompute(bytes, noReferences);
    expect(String(facts["stateMaterialization.stateArtifactDigest"])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("emits no facts for bytes that are not a chain environment record", async () => {
    expect(await chainEnvironmentRecompute(new TextEncoder().encode('{"a":1}'), noReferences)).toEqual({});
  });

  it("emits no facts for re-canonicalized bytes", async () => {
    const document = await goldenJson("chain/closed-local.json");
    const pretty = new TextEncoder().encode(JSON.stringify(document, null, 2));
    expect(await chainEnvironmentRecompute(pretty, noReferences)).toEqual({});
  });
});

describe("crypto-environment record-fact recompute", () => {
  it("recomputes the composite card, counting composed worlds", async () => {
    const document = await goldenJson("composite/composed.json");
    const bytes = sealCryptoEnvironmentRecord(document);
    const chainWorld = document.chainWorld as { record: { digest: { sha256: string } } };
    expect(await cryptoEnvironmentRecompute(bytes, noReferences)).toEqual({
      cryptoEnvironmentRecordDigest: recordDigest(bytes),
      "chainWorld.digest": prefixedDigest(chainWorld.record.digest.sha256),
      informationWorldCount: 2,
      "composition.requestBudget.maxRequests": 200,
    });
  });

  it("reports a chain-only composite as carrying no information plane", async () => {
    const bytes = sealCryptoEnvironmentRecord(await goldenJson("composite/chain-only.json"));
    const facts = await cryptoEnvironmentRecompute(bytes, noReferences);
    expect(facts.informationWorldCount).toBe(0);
    expect(facts["composition.requestBudget.maxRequests"]).toBe(0);
  });
});

describe("information world recompute", () => {
  it("recomputes the card from the record's own sealed bytes", async () => {
    const bytes = await loadInformationWorldGolden();
    const facts = await informationWorldRecompute(bytes, noReferences);
    expect(facts).toMatchObject({
      "capture.fidelity": "synthetic",
      "requestKeyPolicy.version": "irk1",
    });
    expect(facts["corpus.entryCount"]).toBeGreaterThan(0);
    expect(facts.informationWorldRecordDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("re-serialized bytes recompute to nothing, so a card cannot be attached to them", async () => {
    const bytes = await loadInformationWorldGolden();
    const pretty = new TextEncoder().encode(
      JSON.stringify(JSON.parse(new TextDecoder().decode(bytes)), null, 2),
    );
    expect(await informationWorldRecompute(pretty, noReferences)).toEqual({});
  });

  it("the registry resolves this kind and skips unknown ones", () => {
    expect(CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE.get(INFORMATION_WORLD_KIND)).toBeDefined();
    expect(CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE.get("https://jinn.network/records/nope/1.0"))
      .toBeUndefined();
  });
});

describe("the registry", () => {
  it("registers all three kinds and nothing else", () => {
    expect(CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE.get(CHAIN_ENVIRONMENT_KIND)).toBe(chainEnvironmentRecompute);
    expect(CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE.get(CRYPTO_ENVIRONMENT_KIND)).toBe(cryptoEnvironmentRecompute);
    expect(CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE.get(INFORMATION_WORLD_KIND)).toBe(informationWorldRecompute);
    expect(CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE.get("https://jinn.network/records/environment/1.0")).toBeUndefined();
  });
});
