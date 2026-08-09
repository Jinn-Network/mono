import { readRuntimeConfig } from "./runtime-config";
import { cleanupRuntimeWorkspace } from "./runtime-workspace";

export default function globalTeardown(): void {
  cleanupRuntimeWorkspace(readRuntimeConfig());
}
