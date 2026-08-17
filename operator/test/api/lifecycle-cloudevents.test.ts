import { describe, expect, it } from 'vitest';
import {
  activityRowToCloudEvent,
  lifecycleCloudEventType,
  lifecycleKindToKebab,
  operatorLifecycleCloudEventSchema,
} from '../../src/api/contract/lifecycle-cloudevents.js';

describe('lifecycle CloudEvents mapping', () => {
  it('maps task_posted to kebab and the reverse-DNS type', () => {
    expect(lifecycleKindToKebab('task_posted')).toBe('task-posted');
    expect(lifecycleCloudEventType('task_posted')).toBe(
      'network.jinn.operator-lifecycle.task-posted.v1',
    );
  });

  it('still produces a CloudEvent with required data.title for an unknown kind', () => {
    const event = activityRowToCloudEvent(
      {
        id: 42,
        ts: '2026-08-17T00:00:00.000Z',
        kind: 'brand_new_kind_from_newer_daemon',
        requestId: null,
        serviceIndex: null,
        txHash: null,
        solverType: null,
        outcome: 'ok',
        detail: 'something happened',
      },
      { source: 'urn:jinn:operator-daemon:test', subject: 'urn:jinn:operator:local' },
    );
    expect(event.data.title.length).toBeGreaterThan(0);
    expect(event.data.kind).toBe('brand_new_kind_from_newer_daemon');
    expect(event.type).toBe(
      'network.jinn.operator-lifecycle.brand-new-kind-from-newer-daemon.v1',
    );
    expect(operatorLifecycleCloudEventSchema.parse(event).data.title).toBe(event.data.title);
  });

  it('rejects a payload that omits data.title', () => {
    const parsed = operatorLifecycleCloudEventSchema.safeParse({
      specversion: '1.0',
      id: '1',
      source: 'urn:jinn:operator-daemon:test',
      subject: 'urn:jinn:operator:local',
      time: '2026-08-17T00:00:00.000Z',
      datacontenttype: 'application/json',
      type: 'network.jinn.operator-lifecycle.task-posted.v1',
      data: { kind: 'task_posted', severity: 'info', message: 'posted' },
    });
    expect(parsed.success).toBe(false);
  });
});
