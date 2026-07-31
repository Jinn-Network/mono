import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createFilePostingIntentStore } from "./posting-intent-file-store.js";

const CREATOR = "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98" as const;
const KEY = {
  creatorSafe: CREATOR,
  taskCidDigest: `sha256:${"a".repeat(64)}`,
  submissionDigest: `sha256:${"b".repeat(64)}`,
} as const;
const INTENT = { ...KEY, idempotencyKey: "key-1", createdAt: "2026-07-31T00:00:00Z" } as const;

let directory: string;
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function makeDirectory(): string {
  directory = mkdtempSync(join(tmpdir(), "jinn-posting-file-store-"));
  return directory;
}

describe("createFilePostingIntentStore", () => {
  test("a claim survives process death: a fresh store instance still sees it pending", async () => {
    const path = makeDirectory();
    const crashed = createFilePostingIntentStore(path);
    const claim = await crashed.claim(INTENT);
    if (claim.kind !== "owner") throw new Error("expected owner");

    const restarted = createFilePostingIntentStore(path); // the process came back
    const pending = await restarted.scanPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.ownerToken).toBe(claim.ownerToken);
    expect(await restarted.fence(KEY, claim.ownerToken)).toBe(true);
  });

  test("a resolved outcome survives restart with its bigint taskId intact", async () => {
    const path = makeDirectory();
    const store = createFilePostingIntentStore(path);
    const claim = await store.claim(INTENT);
    if (claim.kind !== "owner") throw new Error("expected owner");
    await store.resolve(KEY, claim.ownerToken, { taskId: 2n ** 70n, txHash: `0x${"cd".repeat(32)}` });

    const restarted = createFilePostingIntentStore(path);
    expect(await restarted.lookup(KEY)).toMatchObject({ resolved: { taskId: 2n ** 70n } });
  });

  test("the record is readable JSON keyed by creator and both digests", async () => {
    const path = makeDirectory();
    await createFilePostingIntentStore(path).claim(INTENT);
    const [name] = readdirSync(path);
    expect(name).toBe(`${CREATOR.toLowerCase().slice(2)}-${"a".repeat(64)}-${"b".repeat(64)}.json`);
    expect(JSON.parse(readFileSync(join(path, name!), "utf8"))).toMatchObject({ idempotencyKey: "key-1" });
  });

  test("refuses a key whose components could escape the store directory", async () => {
    const store = createFilePostingIntentStore(makeDirectory());
    await expect(store.claim({ ...INTENT, creatorSafe: "../../etc" as `0x${string}` }))
      .rejects.toThrow(/not a 20-byte address/u);
    await expect(store.claim({ ...INTENT, taskCidDigest: "sha256:../x" as `sha256:${string}` }))
      .rejects.toThrow(/not a sha256/u);
  });

  test("takes over a zero-length record (a claim that died before its record was durable)", async () => {
    const path = makeDirectory();
    const store = createFilePostingIntentStore(path);
    writeFileSync(join(path, `${CREATOR.toLowerCase().slice(2)}-${"a".repeat(64)}-${"b".repeat(64)}.json`), "");
    const claim = await store.claim(INTENT);
    expect(claim.kind).toBe("owner");
    expect(await store.scanPending()).toHaveLength(1);
  });

  test("refuses a non-empty corrupt record instead of silently re-claiming it", async () => {
    const path = makeDirectory();
    const store = createFilePostingIntentStore(path);
    writeFileSync(join(path, `${CREATOR.toLowerCase().slice(2)}-${"a".repeat(64)}-${"b".repeat(64)}.json`), "{ nope");
    await expect(store.claim(INTENT)).rejects.toThrow();
  });

  test("leaves no temp files behind after resolve", async () => {
    const path = makeDirectory();
    const store = createFilePostingIntentStore(path);
    const claim = await store.claim(INTENT);
    if (claim.kind !== "owner") throw new Error("expected owner");
    await store.resolve(KEY, claim.ownerToken, { taskId: 1n, txHash: `0x${"ef".repeat(32)}` });
    expect(readdirSync(path).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
