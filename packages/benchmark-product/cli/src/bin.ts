#!/usr/bin/env node

// Keep the runtime check ahead of every product import. On a cold machine an
// unsupported Node must produce one actionable answer, not a syntax or loader
// failure from deep in the dependency graph.
const nodeMajor = Number(process.versions.node.split(".", 1)[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
  process.stderr.write(`Colophon requires Node 22 or newer; this machine is running Node ${process.versions.node}.\n`);
  process.stderr.write("Install a current Node 22 LTS release, then run the same command again.\n");
  process.exitCode = 2;
} else {
  try {
    const { colophonDataDir } = await import("./data-dir.js");
    const { runColophonCli } = await import("./main.js");
    // Shutdown for the verbs that run until interrupted (`publication serve`). Installed on
    // demand, never at startup: a registered SIGINT listener replaces Node's default
    // termination, so arming one unconditionally would swallow the first Ctrl-C of every other
    // command.
    const createShutdownSignal = () => {
      const shutdown = new AbortController();
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => shutdown.abort());
      return shutdown.signal;
    };
    const result = await runColophonCli(process.argv.slice(2), {
      cwd: process.cwd(),
      createShutdownSignal,
      now: () => new Date(),
      progress: (line) => process.stderr.write(`${line}\n`),
      interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
      agentDataDir: colophonDataDir(),
    });

    if (result.stdout !== "") process.stdout.write(result.stdout);
    if (result.stderr !== "") process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch (cause) {
    process.stderr.write(`Colophon could not start: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
