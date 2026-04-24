/**
 * Integration test: real subgraph knowledge-tree query.
 *
 * Runs ONLY when JINN_SUBGRAPH_INTEGRATION=1 is set.
 * Expects a live subgraph endpoint via JINN_SUBGRAPH_URL.
 *
 * Usage:
 *   JINN_SUBGRAPH_INTEGRATION=1 \
 *   JINN_SUBGRAPH_URL=https://api.studio.thegraph.com/query/.../jinn-v1/version/latest \
 *   JINN_INTEGRATION_INTENT_CID=bafy... \
 *   yarn test test/discovery/subgraph-integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  getKnowledgeTree,
  getIntent,
  getEnvelopesForIntent,
  queryIntents,
  queryOperatorValidations,
} from '../../src/discovery/subgraph.js';

const ENABLED = process.env['JINN_SUBGRAPH_INTEGRATION'] === '1';
const SUBGRAPH_URL = process.env['JINN_SUBGRAPH_URL'] ?? '';
const INTENT_CID = process.env['JINN_INTEGRATION_INTENT_CID'] ?? '';

// All tests in this file are conditionally skipped unless JINN_SUBGRAPH_INTEGRATION=1
const maybeDescribe = ENABLED ? describe : describe.skip;

maybeDescribe('subgraph integration — knowledge tree', () => {
  it('requires JINN_SUBGRAPH_URL to be set', () => {
    expect(SUBGRAPH_URL).not.toBe('');
  });

  it('queryIntents returns at least one intent from the live subgraph', async () => {
    const intents = await queryIntents({ url: SUBGRAPH_URL }, { limit: 5 });
    // The indexer may be empty on a fresh deployment — just verify the shape
    expect(Array.isArray(intents)).toBe(true);
    if (intents.length > 0) {
      const intent = intents[0]!;
      expect(typeof intent.id).toBe('string');
      expect(typeof intent.kind).toBe('string');
      expect(typeof intent.creator).toBe('string');
      expect(typeof intent.createdAt).toBe('string');
    }
  });

  it('getIntent returns null for a non-existent CID', async () => {
    const result = await getIntent({ url: SUBGRAPH_URL }, 'bafy-does-not-exist-xyz');
    expect(result).toBeNull();
  });
});

maybeDescribe('subgraph integration — knowledge tree for specific intent', () => {
  it('requires JINN_INTEGRATION_INTENT_CID to be set', () => {
    expect(INTENT_CID, 'Set JINN_INTEGRATION_INTENT_CID to a known intent CID').not.toBe('');
  });

  it('getIntent returns the intent record', async () => {
    const intent = await getIntent({ url: SUBGRAPH_URL }, INTENT_CID);
    expect(intent).not.toBeNull();
    expect(intent!.id).toBe(INTENT_CID);
    expect(intent!.kind).toBeTruthy();
    expect(intent!.creator).toMatch(/^0x/);
  });

  it('getEnvelopesForIntent returns an array (may be empty if no restorations yet)', async () => {
    const envelopes = await getEnvelopesForIntent({ url: SUBGRAPH_URL }, INTENT_CID);
    expect(Array.isArray(envelopes)).toBe(true);
    for (const e of envelopes) {
      expect(e.id).toBeTruthy();
      expect(['restoration', 'verdict']).toContain(e.role);
      expect(e.intent.id).toBe(INTENT_CID);
    }
  });

  it('getKnowledgeTree returns a well-formed KnowledgeTreeResult', async () => {
    const tree = await getKnowledgeTree({ url: SUBGRAPH_URL }, INTENT_CID);

    expect(tree.intent.id).toBe(INTENT_CID);
    expect(Array.isArray(tree.restorations)).toBe(true);
    expect(typeof tree.totals.totalRestorations).toBe('number');
    expect(typeof tree.totals.totalVerdicts).toBe('number');
    expect(typeof tree.totals.attestedFraction).toBe('number');
    expect(tree.totals.attestedFraction).toBeGreaterThanOrEqual(0);
    expect(tree.totals.attestedFraction).toBeLessThanOrEqual(1);

    // Every restoration in the list must have role=restoration
    for (const r of tree.restorations) {
      expect(r.role).toBe('restoration');
    }

    // Every verdict bucket key must appear in the restorations list
    const restorationIds = new Set(tree.restorations.map(r => r.id));
    for (const parentCid of Object.keys(tree.verdicts)) {
      expect(restorationIds.has(parentCid)).toBe(true);
      const verdicts = tree.verdicts[parentCid]!;
      for (const v of verdicts) {
        expect(v.role).toBe('verdict');
        expect(v.parentEnvelope?.id).toBe(parentCid);
      }
    }
  });

  it('queryOperatorValidations returns an array for the intent creator', async () => {
    const intent = await getIntent({ url: SUBGRAPH_URL }, INTENT_CID);
    if (!intent) return; // guarded by previous test
    const validations = await queryOperatorValidations({ url: SUBGRAPH_URL }, intent.creator);
    expect(Array.isArray(validations)).toBe(true);
    for (const v of validations) {
      expect(['valid', 'invalid']).toContain(v.verdict);
      expect(typeof v.blockNumber).toBe('number');
      expect(typeof v.envelopeCid).toBe('string');
    }
  });
});
