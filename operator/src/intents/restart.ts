/**
 * Daemon-restart intent (headless §4.1 / §10).
 *
 * `POST /api/admin/restart` is a thin front-end over this module. The CLI twin
 * does not invoke it in-process — restarting the CLI would not restart the
 * daemon — it POSTs the control route when the daemon is up.
 */
export interface RestartDaemonInput {
  readonly requestRestart: (opts: { forceRespawn?: boolean }) => void;
  readonly forceRespawn?: boolean;
}

export interface RestartDaemonResult {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly verb: 'restart';
  readonly ok: true;
  readonly scheduled: true;
}

export function restartDaemonIntent(input: RestartDaemonInput): RestartDaemonResult {
  input.requestRestart({ forceRespawn: input.forceRespawn === true });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'restart',
    ok: true,
    scheduled: true,
  };
}
