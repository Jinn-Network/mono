import { describe, it, expect } from 'vitest';
import { TrajectoryCollector } from '../../../src/trajectory/collector.js';
import { tracedSpawn } from '../../../src/trajectory/wrappers/subprocess.js';

describe('tracedSpawn', () => {
  it('runs a command and emits a state_transition span around it', async () => {
    const c = new TrajectoryCollector({ taskCid: 'bafy', runId: 'r' });
    const res = await tracedSpawn({
      collector: c,
      cmd: 'sh',
      args: ['-c', 'echo hello'],
      stateFrom: 'PREPARED',
      stateTo: 'RAN_CLAUDE',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('hello');
    const s = c.snapshot().spans[0];
    expect(s.attributes['jinn.span.kind']).toBe('jinn.state_transition');
    expect(s.attributes['jinn.state.from']).toBe('PREPARED');
    expect(s.attributes['jinn.state.to']).toBe('RAN_CLAUDE');
    expect(s.attributes['subprocess.cmd']).toBe('sh');
    expect(s.attributes['subprocess.exit_code']).toBe(0);
    // stdout surfaces as events
    expect(s.events.some((e) => e.name === 'subprocess.stdout.chunk')).toBe(true);
  });

  it('does NOT record raw stdout bytes in event attributes', async () => {
    // Raw bytes must never land in span events — they may contain tokens,
    // private keys, or JINN_PASSWORD echoes that would be uploaded to IPFS.
    const fakeApiKey = 'sk-ant-api03-supersecret1234567890abcdef';
    const c = new TrajectoryCollector({ taskCid: 'bafy', runId: 'r' });
    const res = await tracedSpawn({
      collector: c,
      cmd: 'sh',
      args: ['-c', `echo "${fakeApiKey}"`],
      stateFrom: 'X',
      stateTo: 'Y',
    });
    expect(res.stdout).toContain(fakeApiKey);

    const span = c.snapshot().spans[0];
    for (const event of span.events) {
      for (const [key, value] of Object.entries(event.attributes ?? {})) {
        // No attribute in any event should contain the raw secret string
        expect(String(value)).not.toContain(fakeApiKey);
        // Specifically, subprocess.stdout.bytes must NOT exist — only .len is allowed
        expect(key).not.toBe('subprocess.stdout.bytes');
        expect(key).not.toBe('subprocess.stderr.bytes');
      }
    }
  });

  it('records stdout chunk length (not raw bytes) in event attributes', async () => {
    const c = new TrajectoryCollector({ taskCid: 'bafy', runId: 'r' });
    await tracedSpawn({
      collector: c,
      cmd: 'sh',
      args: ['-c', 'echo hello'],
      stateFrom: 'X',
      stateTo: 'Y',
    });
    const span = c.snapshot().spans[0];
    const stdoutEvent = span.events.find((e) => e.name === 'subprocess.stdout.chunk');
    expect(stdoutEvent).toBeDefined();
    // Length is a number, not the raw string
    expect(typeof stdoutEvent!.attributes!['subprocess.stdout.len']).toBe('number');
    expect(stdoutEvent!.attributes!['subprocess.stdout.len']).toBeGreaterThan(0);
  });

  it('reports ERROR on non-zero exit', async () => {
    const c = new TrajectoryCollector({ taskCid: 'bafy', runId: 'r' });
    const res = await tracedSpawn({
      collector: c,
      cmd: 'sh',
      args: ['-c', 'exit 3'],
      stateFrom: 'X',
      stateTo: 'Y',
    });
    expect(res.exitCode).toBe(3);
    const s = c.snapshot().spans[0];
    expect(s.status.code).toBe('ERROR');
  });
});
