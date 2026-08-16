/**
 * Fixture builder for a minimal valid JinnTrajectoryV1.
 *
 * Builds a 3-span trajectory:
 *   span[0] — jinn.phase (genesis link)
 *   span[1] — jinn.llm_call (links to span[0])
 *   span[2] — jinn.artifact.emit (links to span[1])
 *
 * Each span carries the required jinn.prevSpanHash set according to the
 * hash-chain rules: span[0].prevSpanHash = computeGenesisHash(taskCid),
 * span[n].prevSpanHash = computePrevSpanHash(span[n-1]).
 *
 * The trajectory fixture is intentionally NOT signed — conformance checks
 * only validate spans; signature is checked separately.
 */

import { computeGenesisHash, computePrevSpanHash } from '../../../src/trajectory/hash-chain.js';
import type { JinnTrajectoryV1 } from '../../../src/trajectory/schema.js';
import type { Span } from '../../../src/trajectory/schema.js';

// Stable test artifact identifiers for the emit span.
// Post jinn-mono-vy37.1.2 the trajectory↔artifact linkage is keyed by sha256
// (artifacts no longer carry IPFS CIDs). The legacy CID is retained as an
// extra attribute only because some older tests still reference it.
export const FIXTURE_ARTIFACT_CID = 'bafy-test-artifact-emit-001';
export const FIXTURE_ARTIFACT_SHA256 = 'c'.repeat(64);
export const FIXTURE_EMIT_SPAN_ID = 'eeee000000000001';

export function buildGoodTrajectoryFixture(taskCid: string): JinnTrajectoryV1 {
  const genesis = computeGenesisHash(taskCid);

  // span[0] — jinn.phase
  const span0: Span = {
    traceId: '0'.repeat(32),
    spanId: 'aaaa000000000001',
    parentSpanId: null,
    name: 'phase.design',
    kind: 'INTERNAL',
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000000001000000',
    attributes: {
      'jinn.span.kind': 'jinn.phase',
      'jinn.prevSpanHash': genesis,
      'jinn.phase.name': 'design',
    },
    events: [],
    status: { code: 'OK' },
  };

  const prevHash1 = computePrevSpanHash(span0);

  // span[1] — jinn.llm_call
  const span1: Span = {
    traceId: '0'.repeat(32),
    spanId: 'bbbb000000000002',
    parentSpanId: 'aaaa000000000001',
    name: 'llm.claude',
    kind: 'CLIENT',
    startTimeUnixNano: '1700000000002000000',
    endTimeUnixNano: '1700000000003000000',
    attributes: {
      'jinn.span.kind': 'jinn.llm_call',
      'jinn.prevSpanHash': prevHash1,
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-4-5',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 50,
    },
    events: [],
    status: { code: 'OK' },
  };

  const prevHash2 = computePrevSpanHash(span1);

  // span[2] — jinn.artifact.emit
  const span2: Span = {
    traceId: '0'.repeat(32),
    spanId: FIXTURE_EMIT_SPAN_ID,
    parentSpanId: 'bbbb000000000002',
    name: 'artifact.emit',
    kind: 'INTERNAL',
    startTimeUnixNano: '1700000000004000000',
    endTimeUnixNano: '1700000000005000000',
    attributes: {
      'jinn.span.kind': 'jinn.artifact.emit',
      'jinn.prevSpanHash': prevHash2,
      'jinn.artifact.cid': FIXTURE_ARTIFACT_CID,
      'jinn.artifact.artifactType': 'output.portfolio.v0',
      'jinn.artifact.sha256': FIXTURE_ARTIFACT_SHA256,
    },
    events: [],
    status: { code: 'OK' },
  };

  return {
    schemaVersion: 'jinn.trajectory.v1',
    runId: 'test-run-id-001',
    parentEnvelopeCid: null,
    spans: [span0, span1, span2],
    redactionManifest: {
      spans: [],
      totalRedactions: 0,
    },
    signature: {
      algo: 'secp256k1',
      signer: '0x' + '22'.repeat(20),
      hash: '0x' + 'ef'.repeat(32),
      sig: '0x' + '12'.repeat(65),
    },
  };
}
