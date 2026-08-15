/** Supervisor-owned credential bridge command. Launchers may select this command in a plan, but
 * the process boundary and the code that opens forwarded secrets stay with the supervisor. */
export function credentialExecArgv(argv: readonly string[]): string[] {
  return [process.execPath, new URL("./credential-exec.mjs", import.meta.url).pathname, "--", ...argv];
}
