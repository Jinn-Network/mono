#!/usr/bin/env tsx
// @ts-nocheck
/**
 * Inspect memory system for a given request/job
 * 
 * Usage:
 *   tsx scripts/memory/inspect-situation.ts <requestId>
 * 
 * This script provides detailed observability into what the memory system
 * remembers about a given job, including:
 * - The SITUATION artifact for the request
 * - Similar situations retrieved from vector search
 * - Recognition phase data if available
 */

import { Client } from 'pg';
import fetch from 'cross-fetch';
import type { Situation, SituationNodeEmbeddingRecord } from 'jinn-node/types/situation.js';

const PONDER_GRAPHQL_URL = process.env.PONDER_GRAPHQL_URL || `http://localhost:${process.env.PONDER_PORT || '42069'}/graphql`;
const IPFS_GATEWAY_BASE = (process.env.IPFS_GATEWAY_URL || 'https://gateway.autonolas.tech/ipfs/').replace(/\/+$/, '/');

function getDatabaseUrl(): string | null {
  const candidates = [
    process.env.NODE_EMBEDDINGS_DB_URL,
    process.env.SITUATION_DB_URL,
    process.env.DATABASE_URL,
    process.env.SUPABASE_DB_URL,
    process.env.SUPABASE_POSTGRES_URL,
  ];
  return candidates.find((url) => typeof url === 'string' && url.length > 0) || null;
}

function serializeVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

interface ArtifactRecord {
  id: string;
  requestId: string;
  name: string;
  cid: string;
  topic: string;
  type?: string;
  contentPreview?: string;
}

async function fetchGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(PONDER_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      console.error(`❌ GraphQL request failed: ${res.status}`);
      return null;
    }
    const json = await res.json();
    if (json.errors) {
      console.error('❌ GraphQL returned errors:', json.errors);
      return null;
    }
    return json.data as T;
  } catch (error: any) {
    console.error('❌ GraphQL error:', error?.message || String(error));
    return null;
  }
}

async function fetchSituationArtifact(requestId: string): Promise<{ artifact: ArtifactRecord | null; situation: Situation | null }> {
  const query = `
    query GetSituationArtifact($requestId: String!) {
      artifacts(where: { AND: [{ requestId: $requestId }, { topic: "SITUATION" }] }, limit: 1) {
        items {
          id
          requestId
          name
          cid
          topic
          type
          contentPreview
        }
      }
    }
  `;

  const data = await fetchGraphQL<{ artifacts: { items: ArtifactRecord[] } }>(query, { requestId });
  const artifact = data?.artifacts?.items?.[0] || null;

  if (!artifact) {
    return { artifact: null, situation: null };
  }

  // Fetch the actual situation content from IPFS
  try {
    const url = `${IPFS_GATEWAY_BASE}${artifact.cid}`;
    const res = await fetch(url, { timeout: 8000 } as any);
    if (!res.ok) {
      console.error(`❌ Failed to fetch IPFS content: ${res.status}`);
      return { artifact, situation: null };
    }
    
    let situationData = await res.json();
    
    // Handle wrapped artifacts
    if (situationData.content && typeof situationData.content === 'string') {
      try {
        situationData = JSON.parse(situationData.content);
      } catch (e) {
        console.error('❌ Failed to parse wrapped artifact content');
      }
    }
    
    return { artifact, situation: situationData as Situation };
  } catch (error: any) {
    console.error('❌ Error fetching situation from IPFS:', error?.message || String(error));
    return { artifact, situation: null };
  }
}

async function fetchNodeEmbedding(requestId: string, client: Client): Promise<SituationNodeEmbeddingRecord | null> {
  try {
    const res = await client.query(
      'SELECT node_id, model, dim, summary, meta, updated_at FROM node_embeddings WHERE node_id = $1',
      [requestId]
    );
    
    if (res.rows.length === 0) {
      return null;
    }
    
    const row = res.rows[0];
    return {
      nodeId: row.node_id,
      model: row.model,
      dim: row.dim,
      vector: [], // Don't fetch full vector for display
      summary: row.summary,
      meta: row.meta,
      updatedAt: row.updated_at,
    };
  } catch (error: any) {
    console.error('❌ Error fetching node embedding:', error?.message || String(error));
    return null;
  }
}

async function searchSimilarSituations(
  vector: number[],
  k: number,
  client: Client
): Promise<Array<{ nodeId: string; score: number; summary: string | null; meta: any }>> {
  try {
    const vectorLiteral = serializeVector(vector);
    const sql = `
      SELECT node_id, summary, meta, score
      FROM (
        SELECT 
          node_id,
          summary,
          meta,
          1 - (vec <=> $1::vector) AS score
        FROM node_embeddings
      ) AS scored
      ORDER BY score DESC
      LIMIT $2;
    `;
    
    const res = await client.query(sql, [vectorLiteral, k]);
    
    return res.rows.map((row) => ({
      nodeId: row.node_id,
      score: typeof row.score === 'string' ? Number(row.score) : Number(row.score ?? 0),
      summary: row.summary,
      meta: row.meta,
    }));
  } catch (error: any) {
    console.error('❌ Error searching similar situations:', error?.message || String(error));
    return [];
  }
}

function formatSituation(situation: Situation): void {
  console.log('\n📋 SITUATION DETAILS:');
  console.log('━'.repeat(80));
  
  console.log('\n🎯 Job Information:');
  console.log(`  Request ID: ${situation.job.requestId}`);
  if (situation.job.jobDefinitionId) console.log(`  Job Definition ID: ${situation.job.jobDefinitionId}`);
  if (situation.job.jobName) console.log(`  Job Name: ${situation.job.jobName}`);
  if (situation.job.objective) {
    console.log(`  Objective: ${situation.job.objective.substring(0, 200)}${situation.job.objective.length > 200 ? '...' : ''}`);
  }
  if (situation.job.acceptanceCriteria) {
    console.log(`  Acceptance Criteria: ${situation.job.acceptanceCriteria.substring(0, 200)}${situation.job.acceptanceCriteria.length > 200 ? '...' : ''}`);
  }
  
  console.log('\n⚡ Execution:');
  console.log(`  Status: ${situation.execution.status}`);
  console.log(`  Trace Steps: ${situation.execution.trace.length}`);
  if (situation.execution.trace.length > 0) {
    console.log('  Key Actions:');
    situation.execution.trace.slice(0, 5).forEach((step, i) => {
      console.log(`    ${i + 1}. ${step.tool}`);
      if (step.args && step.args.length < 100) {
        console.log(`       Args: ${step.args}`);
      }
      console.log(`       Result: ${step.result_summary.substring(0, 80)}${step.result_summary.length > 80 ? '...' : ''}`);
    });
    if (situation.execution.trace.length > 5) {
      console.log(`    ... and ${situation.execution.trace.length - 5} more steps`);
    }
  }
  
  console.log('\n🔗 Context:');
  const parentRequestId = situation.context.parent?.requestId || situation.context.parentRequestId;
  if (parentRequestId) {
    console.log(`  Parent Request: ${parentRequestId}`);
    if (situation.context.parent?.jobDefinitionId) {
      console.log(`  Parent Job Definition: ${situation.context.parent.jobDefinitionId}`);
    }
  }
  const childRequests = situation.context.children || situation.context.childRequestIds;
  if (childRequests && childRequests.length > 0) {
    console.log(`  Child Requests: ${childRequests.join(', ')}`);
  }
  const siblingRequests = situation.context.siblings || situation.context.siblingRequestIds;
  if (siblingRequests && siblingRequests.length > 0) {
    console.log(`  Sibling Requests: ${siblingRequests.slice(0, 3).join(', ')}${siblingRequests.length > 3 ? '...' : ''}`);
  }
  
  if (situation.artifacts && situation.artifacts.length > 0) {
    console.log('\n📦 Artifacts:');
    situation.artifacts.forEach((artifact, i) => {
      console.log(`  ${i + 1}. ${artifact.name} [${artifact.topic}]`);
      if (artifact.contentPreview) {
        console.log(`     Preview: ${artifact.contentPreview.substring(0, 100)}${artifact.contentPreview.length > 100 ? '...' : ''}`);
      }
    });
  }
  
  if (situation.embedding) {
    console.log('\n🧠 Embedding:');
    console.log(`  Model: ${situation.embedding.model}`);
    console.log(`  Dimensions: ${situation.embedding.dim}`);
    console.log(`  Vector Length: ${situation.embedding.vector.length}`);
  }
  
  if (situation.meta?.recognition) {
    console.log('\n💭 Recognition Phase:');
    const recognition = situation.meta.recognition as any;
    if (recognition.markdown) {
      console.log('  Learnings Markdown:');
      const lines = recognition.markdown.split('\n').slice(0, 10);
      lines.forEach((line: string) => console.log(`    ${line}`));
      if (recognition.markdown.split('\n').length > 10) {
        console.log('    ...');
      }
    }
    if (recognition.learnings && Array.isArray(recognition.learnings)) {
      console.log(`  Raw Learnings: ${recognition.learnings.length} items`);
    }
  }
}

function formatNodeEmbedding(embedding: SituationNodeEmbeddingRecord): void {
  console.log('\n💾 DATABASE RECORD:');
  console.log('━'.repeat(80));
  console.log(`  Node ID: ${embedding.nodeId}`);
  console.log(`  Model: ${embedding.model}`);
  console.log(`  Dimensions: ${embedding.dim}`);
  console.log(`  Updated: ${embedding.updatedAt}`);
  if (embedding.summary) {
    console.log(`  Summary: ${embedding.summary.substring(0, 300)}${embedding.summary.length > 300 ? '...' : ''}`);
  }
  if (embedding.meta) {
    console.log('  Metadata fields:', Object.keys(embedding.meta).join(', '));
  }
}

function formatSimilarSituations(
  similar: Array<{ nodeId: string; score: number; summary: string | null; meta: any }>,
  currentRequestId: string
): void {
  console.log('\n🔍 SIMILAR SITUATIONS:');
  console.log('━'.repeat(80));
  
  const filtered = similar.filter(s => s.nodeId !== currentRequestId);
  
  if (filtered.length === 0) {
    console.log('  No similar situations found (excluding self)');
    return;
  }
  
  filtered.forEach((match, i) => {
    console.log(`\n  ${i + 1}. Request ${match.nodeId}`);
    console.log(`     Similarity Score: ${match.score.toFixed(4)}`);
    if (match.summary) {
      console.log(`     Summary: ${match.summary.substring(0, 200)}${match.summary.length > 200 ? '...' : ''}`);
    }
    if (match.meta?.job) {
      const job = match.meta.job;
      if (job.jobName) console.log(`     Job Name: ${job.jobName}`);
      if (job.objective) console.log(`     Objective: ${job.objective.substring(0, 150)}${job.objective.length > 150 ? '...' : ''}`);
    }
  });
}

async function main() {
  const requestId = process.argv[2];
  
  if (!requestId) {
    console.error('Usage: tsx scripts/memory/inspect-situation.ts <requestId>');
    process.exit(1);
  }
  
  console.log('🔎 MEMORY SYSTEM INSPECTION');
  console.log('═'.repeat(80));
  console.log(`Request ID: ${requestId}\n`);
  
  // Fetch the situation artifact
  console.log('📥 Fetching situation artifact...');
  const { artifact, situation } = await fetchSituationArtifact(requestId);
  
  if (!artifact) {
    console.log('❌ No SITUATION artifact found for this request');
    console.log('   This request may not have completed yet, or the situation artifact was not created.');
    process.exit(1);
  }
  
  console.log(`✅ Found artifact: ${artifact.cid}`);
  
  if (!situation) {
    console.log('❌ Could not fetch situation content from IPFS');
    process.exit(1);
  }
  
  formatSituation(situation);
  
  // Connect to database
  const dbUrl = getDatabaseUrl();
  if (!dbUrl) {
    console.log('\n⚠️  Database URL not configured (NODE_EMBEDDINGS_DB_URL or similar)');
    console.log('   Skipping database lookups');
    return;
  }
  
  const client = new Client({ connectionString: dbUrl });
  // Suppress unhandled error events from the client (e.g. unexpected server-side termination)
  client.on('error', (err) => {
    console.warn('⚠️ PG Client encountered error (suppressed):', err.message);
  });
  
  try {
    await client.connect();
    console.log('\n✅ Connected to database');
    
    // Fetch node embedding record
    const embedding = await fetchNodeEmbedding(requestId, client);
    if (embedding) {
      formatNodeEmbedding(embedding);
    } else {
      console.log('\n⚠️  No node embedding record found in database');
    }
    
    // Search for similar situations
    if (situation.embedding && situation.embedding.vector.length > 0) {
      console.log('\n🔎 Searching for similar situations...');
      const similar = await searchSimilarSituations(situation.embedding.vector, 6, client);
      formatSimilarSituations(similar, requestId);
    }
    
  } catch (error: any) {
    console.error('\n❌ Database error:', error?.message || String(error));
  } finally {
    await client.end();
  }
  
  console.log('\n' + '═'.repeat(80));
  console.log('✅ Inspection complete');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
