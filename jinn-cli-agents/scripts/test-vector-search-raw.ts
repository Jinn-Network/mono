#!/usr/bin/env tsx
/**
 * Test vector search directly against PostgreSQL
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

  console.log('🔍 Testing vector search against PostgreSQL\n');
  
  const testQuery = 'OLAS staking contract security';
  console.log(`Query: "${testQuery}"`);
  
  // Generate embedding
  console.log('\n1️⃣ Generating 256-dim embedding...');
  const embedResponse = await embedText({ text: testQuery, dim: 256 });
  const embedData = JSON.parse(embedResponse.content[0].text);
  
  if (!embedData.meta?.ok) {
    console.error('❌ Embedding generation failed:', embedData.meta?.message);
    process.exit(1);
  }
  
  const embedding = embedData.data;
  console.log(`   Model: ${embedding.model}, Dim: ${embedding.dim}, Vector length: ${embedding.vector.length}`);
  
  // Connect to database
  console.log('\n2️⃣ Connecting to database...');
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  console.log('   Connected ✅');
  
  // Check table exists and has data
  console.log('\n3️⃣ Checking node_embeddings table...');
  const countRes = await client.query('SELECT COUNT(*) as count FROM node_embeddings');
  console.log(`   Rows: ${countRes.rows[0].count}`);
  
  // Try vector search
  console.log('\n4️⃣ Executing vector search...');
  const vectorLiteral = serializeVector(embedding.vector);
  const sql = `
    SELECT 
      node_id,
      summary,
      1 - (vec <=> $1::vector) AS score
    FROM node_embeddings
    ORDER BY vec <=> $1::vector
    LIMIT 5;
  `;
  
  try {
    const searchRes = await client.query(sql, [vectorLiteral]);
    console.log(`   Results: ${searchRes.rows.length}`);
    
    if (searchRes.rows.length > 0) {
      console.log('\n📊 Top results:');
      searchRes.rows.forEach((row: any, idx: number) => {
        console.log(`\n${idx + 1}. ${row.node_id.substring(0, 20)}...`);
        console.log(`   Score: ${(row.score * 100).toFixed(2)}%`);
        console.log(`   Summary: ${row.summary?.substring(0, 80)}...`);
      });
    } else {
      console.log('\n❌ No results found!');
    }
  } catch (searchError: any) {
    console.error(`\n❌ Search error: ${searchError.message}`);
    console.error(searchError.stack);
  } finally {
    await client.end();
  }
}

main().catch(console.error);

