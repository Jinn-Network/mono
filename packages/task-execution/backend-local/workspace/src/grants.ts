import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilityGrant } from "./contract.js";

/** Materializes opaque capability-grant handles only; callers resolve values at exec time. */
export async function resolveGrantsToSecrets(grants: readonly CapabilityGrant[], secrets: string): Promise<void> {
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  for (const grant of grants) {
    const suffix = createHash("sha256").update(grant.key, "utf8").digest("hex").slice(0, 16);
    const stem = grant.key.replaceAll(/[^A-Za-z0-9._-]/gu, "_").slice(0, 48) || "grant";
    // The handle identifies the grant without serializing the opaque descriptor, whose shape
    // may contain setup-authority material. The exec-time resolver owns descriptor resolution.
    const handle = JSON.stringify({ grantKey: grant.key, reference: `capability-grant:${suffix}` });
    await writeFile(join(secrets, `${stem}-${suffix}.handle`), handle, { mode: 0o600, flag: "wx" });
  }
}
