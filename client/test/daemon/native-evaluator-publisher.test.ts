import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { documentDigest } from "@jinn-network/task-execution-protocol";
import { openNativeEvaluatorPublisher } from "../../src/daemon/native-evaluator-publisher.js";
import { publicationKey } from "../../src/daemon/native-operation-identity.js";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot() {
  const value = await mkdtemp(join(tmpdir(), "jinn-evaluator-publisher-"));
  roots.push(value);
  return value;
}

const signer = {
  keyId: "did:key:evaluator-discovery",
  sign: () => new Uint8Array([1, 2, 3]),
};

function value(bytes: Uint8Array, sequence: number) {
  const digest = documentDigest(bytes);
  const sourceId = "urn:jinn:evaluator:golden/evaluator-records";
  const evaluationId = `sha256:${"a".repeat(64)}` as const;
  return {
    publication: {
      publicationKey: publicationKey({ sourceId, role: "verdict", recordDigest: digest, availabilityState: "available" }),
      evaluationId,
      sourceId,
      role: "verdict",
      recordDigest: digest,
      status: "intent" as const,
      detail: {},
      createdAt: `2026-08-02T00:00:0${sequence}.000Z`,
    },
    artifact: {
      evaluationId,
      role: "verdict",
      name: "verdict",
      mediaType: "application/vnd.in-toto+json",
      digest,
      bytes,
      createdAt: `2026-08-02T00:00:0${sequence}.000Z`,
    },
  };
}

describe("native evaluator public source", () => {
  it("serves exact bytes from a distinct signed append-only evaluator-records source", async () => {
    const rootDir = await temporaryRoot();
    const publisher = await openNativeEvaluatorPublisher({
      rootDir,
      publicBaseUrl: "https://evaluator.example/native",
      source: { agent: "urn:jinn:evaluator:golden", name: "evaluator-records" },
      signer,
    });
    closers.push(() => publisher.close());
    const firstBytes = new TextEncoder().encode('{"verdict":1}');
    const secondBytes = new TextEncoder().encode('{"verdict":2}');
    const firstValue = value(firstBytes, 1);
    const first = await publisher.publish(firstValue);
    const replay = await publisher.publish(firstValue);
    const second = await publisher.publish(value(secondBytes, 2));
    expect(first.sequence).toBe("0000000000000001");
    expect(replay).toEqual(first);
    expect(second.sequence).toBe("0000000000000002");
    const response = await publisher.handler(new Request(
      `https://evaluator.example/native/records/${documentDigest(firstBytes).slice(7)}`,
    ));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(firstBytes);
  });

  it("allows exactly one lifecycle owner per evaluator source root", async () => {
    const rootDir = await temporaryRoot();
    const first = await openNativeEvaluatorPublisher({
      rootDir,
      publicBaseUrl: "https://evaluator.example/native",
      source: { agent: "urn:jinn:evaluator:golden", name: "evaluator-records" },
      signer,
    });
    closers.push(() => first.close());
    await expect(openNativeEvaluatorPublisher({
      rootDir,
      publicBaseUrl: "https://evaluator.example/native",
      source: { agent: "urn:jinn:evaluator:golden", name: "evaluator-records" },
      signer,
    })).rejects.toThrow(/lifecycle owner/u);
  });

  it("recovers the durable head and appends at the exact next sequence after restart", async () => {
    const rootDir = await temporaryRoot();
    const first = await openNativeEvaluatorPublisher({
      rootDir,
      publicBaseUrl: "https://evaluator.example/native",
      source: { agent: "urn:jinn:evaluator:golden", name: "evaluator-records" },
      signer,
    });
    await first.publish(value(new TextEncoder().encode('{"verdict":1}'), 1));
    await first.close();
    const reopened = await openNativeEvaluatorPublisher({
      rootDir,
      publicBaseUrl: "https://evaluator.example/native",
      source: { agent: "urn:jinn:evaluator:golden", name: "evaluator-records" },
      signer,
    });
    closers.push(() => reopened.close());
    await expect(reopened.publish(value(new TextEncoder().encode('{"verdict":2}'), 2)))
      .resolves.toMatchObject({ sequence: "0000000000000002" });
  });
});
