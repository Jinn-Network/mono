import { writeFileSync } from 'node:fs';

import '@jinn-network/evidence-protocol';
import '@jinn-network/marketplace-binding';
import '@jinn-network/record-discovery-client';
import '@jinn-network/record-discovery-protocol';
import '@jinn-network/task-execution-profiles';
import { documentDigest } from '@jinn-network/task-execution-protocol';
import { canonicalJsonBytes, recordDigest } from '@jinn-network/trust-core';
import '@jinn-network/trust-resolve';

const bytes = canonicalJsonBytes({ kind: 'packed-native-consumer-smoke', schemaVersion: 1 });
const report = {
  schemaVersion: 1,
  verified: true,
  recordDigest: recordDigest(bytes),
  taskDigest: documentDigest(bytes),
};
writeFileSync('native-vertical-verification.json', `${JSON.stringify(report)}\n`, 'utf8');

export const role = 'consumer';
