/** Append-only Harbor Job/Trial identity index. Shared by harvest and observe-as-start. */
import { mkdir, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { artifactsDir } from "../../workspace/layout.js";
import { sha256Hex } from "../../workspace/sealed-store.js";

async function withHarborMappingLock<T>(workspaceDir: string, action: () => Promise<T>): Promise<T> {
  const root = join(artifactsDir(workspaceDir), "harbor", "mappings");
  await mkdir(root, { recursive: true });
  const lock = join(root, ".lock");
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 30_000) await rmdir(lock);
      } catch (recoveryCause) {
        if (!new Set(["ENOENT", "ENOTEMPTY"]).has((recoveryCause as NodeJS.ErrnoException).code ?? "")) throw recoveryCause;
      }
      if (Date.now() >= deadline) throw new Error("timed out acquiring Harbor mapping lock");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  try { return await action(); } finally { await rmdir(lock); }
}

/** Internal lifecycle index primitive, exported for concurrency conformance tests. */
export async function recordHarborDispatchMapping(workspaceDir: string, jinnIdentity: string, jobId: string, trialId: string): Promise<void> {
  const root = join(artifactsDir(workspaceDir), "harbor", "mappings");
  const key = (value: string): string => sha256Hex(new TextEncoder().encode(value));
  const document = canonicalJsonBytes({ schema: "jinn.network/benchmark-product/harbor-dispatch-mapping/1", jinnIdentity, jobId, trialId } as never);
  await withHarborMappingLock(workspaceDir, async () => {
    const paths = [
      join(root, "by-dispatch", `${key(jinnIdentity)}.json`),
      join(root, "by-job", key(jobId), `${key(trialId)}.json`),
      join(root, "by-trial", `${key(`${jobId}:${trialId}`)}.json`),
    ];
    for (const path of paths) {
      try {
        const existing = await readFile(path);
        if (!Buffer.from(existing).equals(Buffer.from(document))) throw new Error("benchmark dispatch and Harbor Job/Trial identities cannot be remapped or reused");
      } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    }
    for (const path of paths) {
      await mkdir(dirname(path), { recursive: true });
      try { await writeFile(path, document, { flag: "wx", mode: 0o600 }); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        if (!Buffer.from(await readFile(path)).equals(Buffer.from(document))) throw new Error("concurrent Harbor identity mapping conflict");
      }
    }
  });
}
