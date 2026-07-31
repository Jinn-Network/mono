import { z } from "zod";

/**
 * Basenames this schema refuses as `bin`. A record that names a shell and passes a script
 * in `args` has reintroduced shell interpolation through the back door, which §4.2 forbids
 * outright. Matching is over the **normalized** basename (see `normalizeBasename`), so this
 * list spells each interpreter once and still catches `bash.exe`, `/bin/SH`, and `Bash`.
 */
export const SHELL_INTERPRETERS = Object.freeze([
  "sh", "bash", "zsh", "dash", "ash", "ksh", "csh", "tcsh", "fish",
  "cmd", "powershell", "pwsh",
  "env",
] as const);

/**
 * Characters that only mean anything to a shell. This is a **structural guard on the
 * document**, not a sandbox: it refuses records whose commands are written as shell text.
 * It makes no claim about what the command does when a runner executes it — containment is
 * the runner's concern, owned by its own design.
 */
export const SHELL_METACHARACTERS = Object.freeze([
  ";", "&", "|", "<", ">", "$", "`", "\\", "\"", "'", "\n", "\r", "(", ")", "{", "}", "*", "?", "~", "!", "#",
] as const);

const metacharacter = new Set<string>(SHELL_METACHARACTERS);

function hasShellMetacharacter(value: string): boolean {
  for (const character of value) {
    if (metacharacter.has(character)) return true;
  }
  return false;
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/**
 * Folds away the two spellings that make the interpreter ban a spelling test rather than a
 * rule: case (`/bin/SH`, `Bash` — the filesystems that carry these names are case-folding)
 * and a Windows executable suffix (`bash.exe`). Both the runtime refinement and the
 * published schema's `SHELL_INTERPRETER_PATTERN` normalize the same way, so the two surfaces
 * reach the same verdict.
 */
function normalizeBasename(name: string): string {
  const lowercase = name.toLowerCase();
  return lowercase.endsWith(".exe") ? lowercase.slice(0, -".exe".length) : lowercase;
}

const interpreter = new Set<string>(SHELL_INTERPRETERS.map(normalizeBasename));

/**
 * Basenames a `bin` value names. A `bin` is one executable path, so this is normally one
 * name — but `"/usr/bin/env bash"` is a command line smuggled into the field, and its
 * whole-string basename (`"env bash"`) matches no interpreter. Splitting on whitespace
 * first is why `env` is on the interpreter list at all: both tokens are then caught.
 */
function binBasenames(bin: string): string[] {
  return bin.split(/\s+/).filter((token) => token.length > 0).map(basename);
}

const shellFreeString = (label: string) =>
  z.string().min(1).refine((value) => !hasShellMetacharacter(value), {
    message: `${label} must not contain shell metacharacters; commands are shell-free (§4.2)`,
  });

const EnvironmentVariableName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "environment variable names are POSIX names");

/**
 * The shell-free command shape (§4.2): `{bin, args[], cwd?, env?}`. Strict — an extra key
 * (`shell`, `script`, or a namespaced one) is not a governed extension here, it is an
 * attempt to smuggle an execution mode into a sealed document.
 */
export const CommandSpecSchema = z.strictObject({
  bin: shellFreeString("bin").refine(
    (value) => !binBasenames(value).some((name) => interpreter.has(normalizeBasename(name))),
    { message: "bin must not be a shell interpreter; commands are shell-free (§4.2)" },
  ),
  args: z.array(shellFreeString("arg")),
  cwd: shellFreeString("cwd").optional(),
  env: z.record(EnvironmentVariableName, shellFreeString("env value")).optional(),
});

export type CommandSpec = z.infer<typeof CommandSpecSchema>;
