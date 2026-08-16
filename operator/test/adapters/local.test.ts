import { describe, it, expect, beforeEach } from 'vitest';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import type { Task, TaskAnnouncement } from '../../src/types/index.js';

describe('LocalAdapter', () => {
  let adapter: LocalAdapter;

  beforeEach(async () => {
    adapter = new LocalAdapter();
    await adapter.initialize();
  });

  it('posts a Task and makes it available for claim', async () => {
    const task: Task = { id: 'task-1', description: 'Test task' };
    const posted = await adapter.postTask(task);
    expect(posted.taskId).toBeDefined();

    const tasks: TaskAnnouncement[] = [];
    for await (const available of adapter.watchForTasks()) {
      tasks.push(available);
      break; // take one — should be the restoration request
    }
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task.role).toBe('restoration');
  });

  it('claim creates an internal request', async () => {
    const task: Task = { id: 'task-1', description: 'Test task' };
    const posted = await adapter.postTask(task);
    await expect(adapter.claimTask(posted.taskId)).resolves.toMatchObject({
      taskId: posted.taskId,
      attemptIndex: 0,
    });
  });

  it('submit makes result available as delivery', async () => {
    const task: Task = { id: 'task-1', description: 'Test task' };
    const posted = await adapter.postTask(task);
    const request = await adapter.claimTask(posted.taskId);
    const requestId = request.requestId;
    await adapter.submitResult(requestId, { data: 'restored' });

    const deliveries: unknown[] = [];
    for await (const delivery of adapter.watchForDeliveries()) {
      deliveries.push(delivery);
      break;
    }
    expect(deliveries).toHaveLength(1);
  });

});
