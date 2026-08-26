/** Explicit readiness gate for the optional real Terminal-Bench 2 external check. It never
 * downloads, starts Docker, or silently substitutes a fixture. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { inheritedTempEnv } from "../child-temp-env.js";

export type TerminalBench2ExternalReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: "opt-in-required" | "selection-material-unavailable" | "docker-unavailable"; readonly detail: string };

export interface TerminalBench2ExternalReadinessInput {
  readonly optIn: boolean;
  readonly dockerExecutable: string;
  readonly registryMetadataPath: string;
  readonly taskMaterialPath: string;
}

export async function terminalBench2ExternalReadiness(input: TerminalBench2ExternalReadinessInput): Promise<TerminalBench2ExternalReadiness> {
  if (!input.optIn) return { ready: false, reason: "opt-in-required", detail: "set COLOPHON_TERMINAL_BENCH_2_EXTERNAL=1 to opt in" };
  if (!existsSync(input.registryMetadataPath) || !existsSync(input.taskMaterialPath)) {
    return { ready: false, reason: "selection-material-unavailable", detail: "an exact downloaded registry snapshot and task package are required; this gate never selects floating latest" };
  }
  const available = await new Promise<boolean>((resolve) => {
    execFile(input.dockerExecutable, ["info", "--format", "{{json .ServerVersion}}"], {
      encoding: "utf8", env: { ...inheritedTempEnv(), PATH: process.env.PATH ?? "", DOCKER_CLI_HINTS: "false" }, timeout: 15_000,
    }, (error) => resolve(error === null));
  });
  return available
    ? { ready: true }
    : { ready: false, reason: "docker-unavailable", detail: "Docker CLI/daemon is unavailable; the external Terminal-Bench 2 check was not attempted" };
}
