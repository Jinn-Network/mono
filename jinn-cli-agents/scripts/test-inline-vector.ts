#!/usr/bin/env tsx
/**
 * Test with fully inline vector (no parameters at all)
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

  console.log('🔍 Testing fully inline vector query\n');
  
  const testQuery = 'OLAS staking contract gas optimization security';
  
  // Generate embedding
  const embedResponse = await embedText({ text: testQuery, dim: 256 });
  const embedData = JSON.parse(embedResponse.content[0].text);
  const embedding = embedData.data;
  
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  
  const vectorLiteral = serializeVector(embedding.vector);
  
  // Fully inline with ORDER BY
  console.log('Testing: Fully inline vector with ORDER BY');
  const sql = `
    SELECT 
      node_id,
      summary,
      1 - (vec <=> '${vectorLiteral}'::vector) AS score
    FROM node_embeddings
    ORDER BY vec <=> '${vectorLiteral}'::vector
    LIMIT 5;
  `;
  
  console.log(`Vector literal length: ${vectorLiteral.length} chars`);
  console.log(`SQL length: ${sql.length} chars\n`);
  
  try {
    const res = await client.query(sql);
    console.log(`✅ Results: ${res.rows.length}`);
    
    if (res.rows.length > 0) {
      console.log('\n📊 Top results:');
      res.rows.forEach((row: any, idx: number) => {
        console.log(`${idx + 1}. ${row.node_id.substring(0, 20)}... - Score: ${(row.score * 100).toFixed(2)}%`);
        console.log(`   ${row.summary?.substring(0, 60)}...`);
      });
    }
  } catch (err: any) {
    console.error(`❌ Error: ${err.message}`);
    console.error(err.stack);
  }
  
  await client.end();
}

main().catch(console.error);

