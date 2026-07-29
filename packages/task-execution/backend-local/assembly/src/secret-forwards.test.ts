import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    grants: [{ key: "evaluator-key", descriptor: { reference: "opaque" } }],
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
    grants: [{ key: "evaluator-key", descriptor: { reference: "opaque" } }],
    resolver: { resolve },
  })).rejects.toThrow("portable basename");
  expect(resolve).not.toHaveBeenCalled();
});

test("rejects duplicate or missing grants before resolver I/O", async () => {
  const root = await mkdtemp(join(tmpdir(), "jinn-secret-forward-"));
  roots.push(root);
  const resolve = vi.fn();
  const input = {
    attempt: { attemptUri: "urn:uuid:11111111-1111-4111-8111-111111111111", nonce: "n", attemptNumber: 1 },
    secrets: join(root, "secrets"),
    grants: [{ key: "one", descriptor: { reference: "opaque" } }],
    resolver: { resolve },
  } as const;

  await expect(materializeSecretForwards({ ...input, forwards: [
    { grantKey: "one", target: "one" }, { grantKey: "one", target: "two" },
  ] })).rejects.toThrow("unique");
  await expect(materializeSecretForwards({ ...input, forwards: [
    { grantKey: "missing", target: "missing" },
  ] })).rejects.toThrow("missing grant");
  await expect(materializeSecretForwards({
    ...input,
    grants: [
      { key: "one", descriptor: { reference: "first" } },
      { key: "one", descriptor: { reference: "second" } },
    ],
    forwards: [{ grantKey: "one", target: "one" }],
  })).rejects.toThrow("unique keys");
  expect(resolve).not.toHaveBeenCalled();
});

test("refuses existing and symlink targets and zeroes resolver-owned buffers", async () => {
  const root = await mkdtemp(join(tmpdir(), "jinn-secret-forward-"));
  roots.push(root);
  const secrets = join(root, "secrets");
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  await writeFile(join(secrets, "exists"), "existing", { mode: 0o600 });
  await symlink(join(root, "outside"), join(secrets, "linked"));
  const bytes = new TextEncoder().encode("secret-value");
  const resolve = vi.fn(async () => bytes);
  const input = {
    attempt: { attemptUri: "urn:uuid:11111111-1111-4111-8111-111111111111", nonce: "n", attemptNumber: 1 },
    secrets,
    grants: [{ key: "one", descriptor: { reference: "opaque" } }],
    resolver: { resolve },
  } as const;

  await expect(materializeSecretForwards({ ...input, forwards: [{ grantKey: "one", target: "exists" }] }))
    .rejects.toThrow();
  await expect(materializeSecretForwards({ ...input, forwards: [{ grantKey: "one", target: "linked" }] }))
    .rejects.toThrow();
  expect(bytes).toEqual(new Uint8Array(bytes.length));
});
