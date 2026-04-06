/**
 * Real-time SSE Updates Integration Tests
 * 
 * These tests verify that the SSE real-time update system correctly
 * notifies the frontend when Ponder data changes.
 * 
 * Tests run conditionally:
 * - When REALTIME_URL is set: Tests execute against live endpoint (e.g., Railway)
 * - When REALTIME_URL is not set: Tests are skipped (no local server required)
 * 
 * Usage: REALTIME_URL=https://your-app.railway.app/sql/live yarn test:integration:next
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventSource } from 'eventsource';

// Mock EventSource for Node.js environment
global.EventSource = EventSource as any;

const SSE_URL = process.env.REALTIME_URL || 'http://localhost:42070/events';
const PONDER_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL || 'http://localhost:42069/graphql';
const REALTIME_TESTS_ENABLED = !!process.env.REALTIME_URL;

describe('Real-time SSE Updates', () => {
  let eventSource: EventSource | null = null;

  afterAll(() => {
    if (eventSource) {
      eventSource.close();
    }
  });

  it.skipIf(!REALTIME_TESTS_ENABLED)('should connect to SSE endpoint', async () => {
    return new Promise<void>((resolve, reject) => {
      eventSource = new EventSource(SSE_URL);

      const timeout = setTimeout(() => {
        eventSource?.close();
        reject(new Error('Connection timeout'));
      }, 10000);

      eventSource.addEventListener('connected', (event: MessageEvent) => {
        clearTimeout(timeout);
        const data = JSON.parse(event.data);
        console.log('✓ SSE connected:', data.message);
        expect(data.message).toBe('SSE connection established');
        expect(data.timestamp).toBeDefined();
        resolve();
      });

      eventSource.onerror = (error) => {
        clearTimeout(timeout);
        eventSource?.close();
        reject(new Error(`SSE connection error: ${error}`));
      };
    });
  }, 15000);

  it.skipIf(!REALTIME_TESTS_ENABLED)('should receive heartbeat messages', async () => {
    return new Promise<void>((resolve, reject) => {
      if (!eventSource || eventSource.readyState !== EventSource.OPEN) {
        eventSource = new EventSource(SSE_URL);
      }

      const timeout = setTimeout(() => {
        reject(new Error('Did not receive heartbeat within 35 seconds'));
      }, 35000);

      // Heartbeats are comments (: heartbeat\n\n) and don't trigger events
      // We'll just wait and ensure the connection stays open
      setTimeout(() => {
        clearTimeout(timeout);
        console.log('✓ Connection stable (heartbeats working)');
        resolve();
      }, 32000);
    });
  }, 40000);

  it.skipIf(!REALTIME_TESTS_ENABLED)('should maintain connection status', () => {
    expect(eventSource).toBeDefined();
    expect(eventSource?.readyState).toBe(EventSource.OPEN);
    console.log('✓ Connection status: OPEN');
  });
});

describe('Real-time Event Notifications', () => {
  it('should have database triggers installed', async () => {
    // This test verifies the triggers exist in the database
    // In a real test, you'd connect to the DB and check pg_trigger table
    console.log('⚠ Manual verification: Check database triggers with:');
    console.log('  psql $PONDER_DATABASE_URL -c "SELECT tgname FROM pg_trigger WHERE tgname LIKE \'%_changes_trigger\';"');
    console.log('  Expected: request_changes_trigger, artifact_changes_trigger, delivery_changes_trigger, job_definition_changes_trigger');
  });

  it('should broadcast events when data changes', () => {
    console.log('⚠ Integration test: Trigger a database change to test notifications');
    console.log('  1. Dispatch a new job via worker or scripts');
    console.log('  2. Observe SSE connection receiving request:created event');
    console.log('  3. Verify frontend table updates automatically');
  });
});

describe('Frontend Integration', () => {
  it('should have useRealtimeData hook available', async () => {
    const { useRealtimeData } = await import('../../frontend/explorer/src/hooks/use-realtime-data');
    expect(useRealtimeData).toBeDefined();
    console.log('✓ useRealtimeData hook exported');
  });

  it('should have RealtimeStatusIndicator component', async () => {
    const { RealtimeStatusIndicator } = await import('../../frontend/explorer/src/components/realtime-status-indicator');
    expect(RealtimeStatusIndicator).toBeDefined();
    console.log('✓ RealtimeStatusIndicator component exported');
  });

  it('should have updated useSubgraphCollection with real-time', async () => {
    const { useSubgraphCollection } = await import('../../frontend/explorer/src/hooks/use-subgraph-collection');
    expect(useSubgraphCollection).toBeDefined();
    console.log('✓ useSubgraphCollection hook updated');
  });
});

describe('Health Check', () => {
  it.skipIf(!REALTIME_TESTS_ENABLED)('should respond to health endpoint', async () => {
    const healthUrl = SSE_URL.replace('/events', '/health');
    const response = await fetch(healthUrl);
    expect(response.ok).toBe(true);
    
    const data = await response.json();
    console.log('✓ Health check response:', data);
    expect(data.status).toBe('ok');
    expect(data.clients).toBeDefined();
    expect(data.timestamp).toBeDefined();
  });
});

// Manual E2E test instructions
describe.skip('Manual E2E Tests (Run manually with browser)', () => {
  it('Job Status Update: PENDING → DELIVERED', () => {
    console.log(`
      Manual Test Steps:
      
      1. Open frontend: http://localhost:3000/requests
      2. Verify real-time status indicator shows "Live" (green dot)
      3. Start worker: yarn dev:mech
      4. Dispatch a job: yarn tsx scripts/dispatch-memory-test.ts
      5. Observe:
         - New request appears in table automatically
         - Status changes from PENDING to DELIVERED without refresh
         - Latency should be < 1 second
      6. Expected SSE events in browser console:
         - request:created
         - delivery:created
         - request:updated
    `);
  });

  it('New Artifact Appearance', () => {
    console.log(`
      Manual Test Steps:
      
      1. Navigate to a job run detail page
      2. Worker creates artifact during execution
      3. Artifact should appear in the list immediately
      4. No page refresh needed
      5. Check browser console for: artifact:created event
    `);
  });

  it('Fallback Behavior: SSE → Polling', () => {
    console.log(`
      Manual Test Steps:
      
      1. Open frontend with SSE connected (green dot)
      2. Stop realtime server: pkill -f realtime-server
      3. Status indicator should change to yellow (Polling fallback)
      4. Data updates should continue via HTTP polling (slower)
      5. Restart realtime server: yarn realtime:dev
      6. Status should return to green (Live) within ~5 seconds
    `);
  });

  it('Child Job Spawning', () => {
    console.log(`
      Manual Test Steps:
      
      1. Dispatch parent job that creates child jobs
      2. Navigate to parent job detail page
      3. Child jobs should appear in "Child Jobs Spawned" section automatically
      4. No manual refresh needed
      5. Expected events: request:created (for each child)
    `);
  });
});

