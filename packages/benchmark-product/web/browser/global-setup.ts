import { readRuntimeConfig } from "./runtime-config";
import { prepareRuntimeWorkspace } from "./runtime-workspace";

export default function globalSetup(): void {
  prepareRuntimeWorkspace(readRuntimeConfig());
}
