#!/usr/bin/env node

// Keep this check ahead of every package import. A reader on an unsupported
// machine should get one actionable answer, not a loader failure from the
// verification dependency graph.
const nodeMajor = Number(process.versions.node.split(".", 1)[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
  process.stderr.write(`Colophon Verify requires Node 22 or newer; this machine is running Node ${process.versions.node}.\n`);
  process.stderr.write("Install a current Node 22 LTS release, then run the same command again.\n");
  process.exitCode = 2;
} else {
  const { runVerifierCli } = await import("./cli.js");
  const result = await runVerifierCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
