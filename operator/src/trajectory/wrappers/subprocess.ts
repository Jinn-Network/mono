/**
 * Traced subprocess wrapper.
 *
 * Emits one jinn.state_transition span per invocation. stdout + stderr
 * chunks are tracked as span events (subprocess.stdout.chunk /
 * subprocess.stderr.chunk) but ONLY their byte lengths are recorded as
 * event attributes — NOT the raw bytes. This prevents subprocess output
 * (which may include API keys, private keys, or JINN_PASSWORD echoes)
 * from landing in span events and being uploaded to IPFS.
 *
 * The full output is returned to the caller for in-memory use only.
 *
 * Attested-tier extension (V2): chunk content encrypted-at-rest if policy
 * demands it. V1 records metadata only.
 */

import { spawn } from 'node:child_process';
import type { TrajectoryCollector } from '../collector.js';

export interface TracedSpawnParams {
  collector: TrajectoryCollector;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  stateFrom: string;
  stateTo: string;
  parentSpanId?: string;
}

export interface TracedSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function nowNanos(): string {
  return `${BigInt(Date.now()) * 1_000_000n}`;
}

export async function tracedSpawn(p: TracedSpawnParams): Promise<TracedSpawnResult> {
  const start = nowNanos();
  let stdout = '';
  let stderr = '';
  const events: { timeUnixNano: string; name: string; attributes?: Record<string, unknown> }[] = [];

  const child = spawn(p.cmd, p.args, { env: p.env, cwd: p.cwd });

  child.stdout.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    stdout += s;
    // Record chunk length only — raw bytes must not enter span events as they
    // may contain API keys, private keys, or other secrets.
    events.push({
      timeUnixNano: nowNanos(),
      name: 'subprocess.stdout.chunk',
      attributes: { 'subprocess.stdout.len': s.length },
    });
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    stderr += s;
    // Record chunk length only — same reason as above.
    events.push({
      timeUnixNano: nowNanos(),
      name: 'subprocess.stderr.chunk',
      attributes: { 'subprocess.stderr.len': s.length },
    });
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  });

  p.collector.addSpan({
    name: `subprocess.${p.cmd}`,
    kind: 'INTERNAL',
    startTimeUnixNano: start,
    endTimeUnixNano: nowNanos(),
    attributes: {
      'jinn.span.kind': 'jinn.state_transition',
      'jinn.state.from': p.stateFrom,
      'jinn.state.to': p.stateTo,
      'subprocess.cmd': p.cmd,
      'subprocess.args': p.args,
      'subprocess.exit_code': exitCode,
    },
    events,
    status: exitCode === 0 ? { code: 'OK' } : { code: 'ERROR', message: `exit ${exitCode}` },
    parentSpanId: p.parentSpanId,
  });

  return { exitCode, stdout, stderr };
}
