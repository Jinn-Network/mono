import { describe, expect, it } from 'vitest';
import { parseOperatorLifecycleSseData } from './events.js';

describe('parseOperatorLifecycleSseData', () => {
  it('accepts a lifecycle CloudEvent payload', () => {
    const parsed = parseOperatorLifecycleSseData(JSON.stringify({
      specversion: '1.0',
      id: '7',
      source: 'urn:jinn:operator-daemon:test',
      subject: 'urn:jinn:operator:local',
      time: '2026-08-17T00:00:00.000Z',
      datacontenttype: 'application/json',
      type: 'network.jinn.operator-lifecycle.task-posted.v1',
      data: {
        kind: 'task_posted',
        title: 'Task Posted',
        severity: 'success',
        message: 'posted',
      },
    }));
    expect(parsed).not.toBeNull();
    expect(parsed?.data.kind).toBe('task_posted');
    expect(parsed?.data.title).toBe('Task Posted');
  });

  it('rejects the retired StructuredEvent shape', () => {
    expect(parseOperatorLifecycleSseData(JSON.stringify({
      schemaVersion: 1,
      id: 'e1',
      ts: '2026-08-17T00:00:00.000Z',
      kind: 'system',
      message: 'boot',
    }))).toBeNull();
  });
});
