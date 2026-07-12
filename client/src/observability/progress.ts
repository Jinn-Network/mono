/**
 * --json-progress: emit NDJSON progress envelopes on stdout during long
 * phases (init, bootstrap, daemon startup). The `jinn run --json-progress`
 * flag flips JINN_JSON_PROGRESS=1 in run.ts before calling main(); when
 * unset this is a no-op so tests / non-flag invocations stay silent on
 * stdout.
 */
function progressEnabled(): boolean {
  return process.env['JINN_JSON_PROGRESS'] === '1';
}

export interface ProgressEnvelope {
  type: 'progress';
  phase: 'init' | 'bootstrap' | 'daemon';
  step: string;
  attempt?: number;
  blocking?: boolean;
  nextAction?: string;
  addresses?: Record<string, string>;
  estimatedWaitMs?: number;
}

export function emitProgress(envelope: ProgressEnvelope): void {
  if (progressEnabled()) {
    process.stdout.write(JSON.stringify(envelope) + '\n');
  }
}
