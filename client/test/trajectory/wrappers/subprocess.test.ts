import { describe, it, expect } from 'vitest';
import { TrajectoryCollector } from '../../../src/trajectory/collector.js';
import { tracedSpawn } from '../../../src/trajectory/wrappers/subprocess.js';

describe('tracedSpawn', () => {
  it('runs a command and emits a state_transition span around it', async () => {
    const c = new TrajectoryCollector({ intentCid: 'bafy', runId: 'r' });
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
    // stdout / stderr surface as events, not attribute bytes (keeps span small)
    expect(s.events.some((e) => e.name === 'subprocess.stdout.chunk')).toBe(true);
  });

  it('reports ERROR on non-zero exit', async () => {
    const c = new TrajectoryCollector({ intentCid: 'bafy', runId: 'r' });
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
