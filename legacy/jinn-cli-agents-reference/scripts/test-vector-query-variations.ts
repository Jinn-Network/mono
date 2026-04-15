#!/usr/bin/env tsx
/**
 * Test different ways of executing the vector query to find the issue
 */

import { Client } from 'pg';
import 'dotenv/config';
import { embedText } from 'jinn-node/agent/mcp/tools/embed_text.js';

function serializeVector(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

async function main() {
  const dbUrl = process.env.SUPABASE_POSTGRES_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('❌ No database URL configured');
    process.exit(1);
  }

  console.log('🔍 Testing different vector query methods\n');
  
  const testQuery = 'OLAS staking contract gas optimization security';
  
  // Generate embedding
  const embedResponse = await embedText({ text: testQuery, dim: 256 });
  const embedData = JSON.parse(embedResponse.content[0].text);
  const embedding = embedData.data;
  console.log(`📊 Embedding: model=${embedding.model}, dim=${embedding.dim}, length=${embedding.vector.length}\n`);
  
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  
  // Test 1: Parameterized with $1::vector and $2 (like search_similar_situations)
  console.log('1️⃣ Test: Parameterized query with $1::vector, $2');
  try {
    const vectorLiteral = serializeVector(embedding.vector);
    const sql1 = `
      SELECT 
        node_id,
        summary,
        1 - (vec <=> $1::vector) AS score
      FROM node_embeddings
      ORDER BY vec <=> $1::vector
      LIMIT $2;
    `;
    const res1 = await client.query(sql1, [vectorLiteral, 5]);
    console.log(`   Results: ${res1.rows.length}`);
    if (res1.rows.length > 0) {
      console.log(`   Top result: ${res1.rows[0].node_id.substring(0, 20)}..., score: ${(res1.rows[0].score * 100).toFixed(2)}%`);
    }
  } catch (err: any) {
    console.error(`   ❌ Error: ${err.message}`);
  }
  
  // Test 2: Parameterized with just $1 for vector, literal 5
  console.log('\n2️⃣ Test: Parameterized query with $1, literal LIMIT 5');
  try {
    const vectorLiteral = serializeVector(embedding.vector);
    const sql2 = `
      SELECT 
        node_id,
        summary,
        1 - (vec <=> $1::vector) AS score
      FROM node_embeddings
      ORDER BY vec <=> $1::vector
      LIMIT 5;
    `;
    const res2 = await client.query(sql2, [vectorLiteral]);
    console.log(`   Results: ${res2.rows.length}`);
    if (res2.rows.length > 0) {
      console.log(`   Top result: ${res2.rows[0].node_id.substring(0, 20)}..., score: ${(res2.rows[0].score * 100).toFixed(2)}%`);
    }
  } catch (err: any) {
    console.error(`   ❌ Error: ${err.message}`);
  }
  
  // Test 3: Check if there's an issue with ORDER BY vs WHERE
  console.log('\n3️⃣ Test: Query without ORDER BY (just SELECT)');
  try {
    const vectorLiteral = serializeVector(embedding.vector);
    const sql3 = `
      SELECT 
        node_id,
        summary,
        1 - (vec <=> $1::vector) AS score
      FROM node_embeddings
      LIMIT 5;
    `;
    const res3 = await client.query(sql3, [vectorLiteral]);
    console.log(`   Results: ${res3.rows.length}`);
    if (res3.rows.length > 0) {
      console.log(`   First result: ${res3.rows[0].node_id.substring(0, 20)}..., score: ${(res3.rows[0].score * 100).toFixed(2)}%`);
    }
  } catch (err: any) {
    console.error(`   ❌ Error: ${err.message}`);
  }
  
  // Test 4: Check table directly (no vector operations)
  console.log('\n4️⃣ Test: Simple SELECT without vector operations');
  try {
    const sql4 = `SELECT node_id, summary FROM node_embeddings LIMIT 3;`;
    const res4 = await client.query(sql4);
    console.log(`   Results: ${res4.rows.length}`);
    if (res4.rows.length > 0) {
      res4.rows.forEach((row, idx) => {
        console.log(`   ${idx + 1}. ${row.node_id.substring(0, 20)}...`);
      });
    }
  } catch (err: any) {
    console.error(`   ❌ Error: ${err.message}`);
  }
  
  // Test 5: Check if pgvector extension is loaded
  console.log('\n5️⃣ Test: Check pgvector extension');
  try {
    const sql5 = `SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';`;
    const res5 = await client.query(sql5);
    if (res5.rows.length > 0) {
      console.log(`   Extension: ${res5.rows[0].extname}, version: ${res5.rows[0].extversion} ✅`);
    } else {
      console.log(`   ❌ pgvector extension not found!`);
    }
  } catch (err: any) {
    console.error(`   ❌ Error: ${err.message}`);
  }
  
  await client.end();
  console.log('\n✅ Tests complete');
}

main().catch(console.error);

