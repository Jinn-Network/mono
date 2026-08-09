import { readRuntimeConfig } from "./runtime-config";
import { cleanupRuntimeWorkspace, prepareRuntimeWorkspace } from "./runtime-workspace";

export default function globalSetup(): () => void {
  const runtime = readRuntimeConfig();
  const ownership = prepareRuntimeWorkspace(runtime);
  // Playwright retains and invokes this closure during teardown. The original
  // BigInt inode identities never cross a JSON or filesystem trust boundary.
  return () => cleanupRuntimeWorkspace(runtime, ownership);
}
