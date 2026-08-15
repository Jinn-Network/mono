import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { NativeOperatorStateRepository } from '../../src/daemon/native-operator-state.js';
import { Store } from '../../src/store/store.js';

const path = process.argv[2];
if (path === undefined) throw new Error('worker lease fixture requires a SQLite path');

const store = new Store(path);
const state = new NativeOperatorStateRepository(store, {
  now: () => new Date('2026-08-02T00:00:00Z'),
});
state.acquireLease({
  role: 'solver',
  chainId: 84532,
  coordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
  operatorAgent: 'urn:jinn:operator:solver-a',
  ownerId: 'B807-child',
  ttlMs: 60_000,
});
process.stdout.write('{"ready":true}\n');

const keepAlive = setInterval(() => undefined, 1_000);
function close(): void {
  clearInterval(keepAlive);
  store.close();
  process.exit(0);
}
process.once('SIGTERM', close);
process.once('SIGINT', close);
