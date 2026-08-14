import { execFileSync } from "node:child_process";
import type { AgentAdapter, AgentProfile } from "./profile.js";

const VERSION_TIMEOUT_MS = 5_000;
const VERSION_MAX_BUFFER = 16 * 1024;
const SEMVER = "([0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)";
const CLAUDE_VERSION = new RegExp(`^${SEMVER} \\(Claude Code\\)$`, "u");
const CODEX_VERSION = new RegExp(`^codex-cli ${SEMVER}$`, "u");

export type AgentVersionCommand = (
  executable: string,
  args: readonly string[],
) => string;

const defaultVersionCommand: AgentVersionCommand = (executable, args) => execFileSync(
  executable,
  [...args],
  {
    encoding: "utf8",
    timeout: VERSION_TIMEOUT_MS,
    maxBuffer: VERSION_MAX_BUFFER,
    windowsHide: true,
    env: { PATH: process.env.PATH ?? "" },
  },
);

export function parseAgentVersion(adapter: AgentAdapter, output: string): string {
  const normalized = output.trim();
  const match = (adapter === "claude-code" ? CLAUDE_VERSION : CODEX_VERSION).exec(normalized);
  if (match === null) throw new Error(`${adapter} emitted unsupported version output`);
  return match[1]!;
}

/** Executes only the adapter's local --version surface; it makes no provider request. */
export function observeAgentVersion(
  profile: Pick<AgentProfile, "adapter" | "executable">,
  command: AgentVersionCommand = defaultVersionCommand,
): string {
  return parseAgentVersion(profile.adapter, command(profile.executable.path, ["--version"]));
}
