import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilityGrant } from "./contract.js";

/** Materializes opaque capability-grant handles only; callers resolve values at exec time. */
export async function resolveGrantsToSecrets(grants: readonly CapabilityGrant[], secrets: string): Promise<void> {
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  for (const grant of grants) {
    await writeFile(join(secrets, grant.key.replaceAll("/", "_")), JSON.stringify({ descriptor: grant.descriptor }), { mode: 0o600 });
  }
}
