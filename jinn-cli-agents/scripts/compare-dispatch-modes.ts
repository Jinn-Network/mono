#!/usr/bin/env tsx
/**
 * Compare dispatch modes: cyclic vs scheduled.
 *
 * Queries Ponder for requests by ventureId and produces comparison metrics
 * between the existing cyclic workstream and the new scheduled dispatch system.
 *
 * Usage:
 *   tsx scripts/compare-dispatch-modes.ts --ventureId <uuid> [--days 7]
 */

import 'dotenv/config';

const PONDER_GRAPHQL_URL = process.env.PONDER_GRAPHQL_URL || 'https://indexer.jinn.network/graphql';

interface ComparisonMetrics {
  mode: string;
  dispatches: number;
  delivered: number;
  measurementArtifacts: number;
  measurementCoverage: string;
  avgDurationMinutes: number | null;
  orchestrationOverhead: string;
}

async function graphql<T>(query: string, variables?: Record<string, any>): Promise<T> {
  const resp = await fetch(PONDER_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await resp.json();
  if (json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function main() {
  const args = process.argv.slice(2);
  const ventureIdIdx = args.indexOf('--ventureId');
  const daysIdx = args.indexOf('--days');

  if (ventureIdIdx === -1 || !args[ventureIdIdx + 1]) {
    console.error('Usage: tsx scripts/compare-dispatch-modes.ts --ventureId <uuid> [--days 7]');
    process.exit(1);
  }

  const ventureId = args[ventureIdIdx + 1];
  const days = daysIdx !== -1 ? parseInt(args[daysIdx + 1] || '7') : 7;
  const sinceTimestamp = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

  console.log(`\nComparing dispatch modes for venture ${ventureId} (last ${days} days)\n`);

  // Query scheduled dispatches (have ventureId set)
  const scheduled = await graphql<{
    requests: { items: Array<{ id: string; delivered: boolean; blockTimestamp: string; templateId: string | null }> };
  }>(`query {
    requests(
      where: { ventureId: "${ventureId}", blockTimestamp_gte: "${sinceTimestamp}" }
      limit: 500
      orderBy: "blockTimestamp"
      orderDirection: "desc"
    ) {
      items { id delivered blockTimestamp templateId }
  }`);

  // Query measurement artifacts for this venture
  const measurements = await graphql<{
    artifacts: { items: Array<{ id: string; type: string; blockTimestamp: string }> };
  }>(`query {
    artifacts(
      where: { topic: "MEASUREMENT", blockTimestamp_gte: "${sinceTimestamp}" }
      limit: 500
    ) {
      items { id topic blockTimestamp }
  }`);

  const scheduledItems = scheduled?.requests?.items || [];
  const measurementItems = measurements?.artifacts?.items || [];

  const scheduledDelivered = scheduledItems.filter(r => r.delivered).length;
  const scheduledMeasurements = measurementItems.length;

  // Format output
  console.log('                        Cyclic          Scheduled');
  console.log('─'.repeat(60));
  console.log(`Dispatches:             N/A             ${scheduledItems.length}`);
  console.log(`Delivered:              N/A             ${scheduledDelivered}`);
  console.log(`Measurement artifacts:  N/A             ${scheduledMeasurements}`);
  console.log(`Measurement coverage:   N/A             ${scheduledItems.length > 0 ? ((scheduledMeasurements / scheduledItems.length * 100).toFixed(0) + '%') : 'N/A'}`);
  console.log();
  console.log('Note: Cyclic metrics require querying by workstreamId (root_workstream_id from venture).');
  console.log('Run with the cyclic workstream active to compare both columns.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
