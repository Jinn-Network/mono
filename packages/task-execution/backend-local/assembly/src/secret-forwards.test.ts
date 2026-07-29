import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { materializeSecretForwards } from "./secret-forwards.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("materializes a resolver-owned secret into an exclusive 0600 declared target", async () => {
  const root = await mkdtemp(join(tmpdir(), "jinn-secret-forward-"));
  roots.push(root);
  const resolve = vi.fn(async () => new TextEncoder().encode("secret-value"));

  await materializeSecretForwards({
    attempt: { attemptUri: "urn:uuid:11111111-1111-4111-8111-111111111111", nonce: "n", attemptNumber: 1 },
    secrets: join(root, "secrets"),
    forwards: [{ grantKey: "evaluator-key", target: "evaluator.pem" }],
    grants: new Map([["evaluator-key", { reference: "opaque" }]]),
    resolver: { resolve },
  });

  const target = join(root, "secrets", "evaluator.pem");
  expect(await readFile(target, "utf8")).toBe("secret-value");
  expect((await lstat(target)).mode & 0o777).toBe(0o600);
  expect(resolve).toHaveBeenCalledOnce();
});

test("rejects a hostile declared target before calling the resolver", async () => {
  const root = await mkdtemp(join(tmpdir(), "jinn-secret-forward-"));
  roots.push(root);
  const resolve = vi.fn();

  await expect(materializeSecretForwards({
    attempt: { attemptUri: "urn:uuid:11111111-1111-4111-8111-111111111111", nonce: "n", attemptNumber: 1 },
    secrets: join(root, "secrets"),
    forwards: [{ grantKey: "evaluator-key", target: "../escape" }],
    grants: new Map([["evaluator-key", { reference: "opaque" }]]),
    resolver: { resolve },
  })).rejects.toThrow("portable basename");
  expect(resolve).not.toHaveBeenCalled();
});
