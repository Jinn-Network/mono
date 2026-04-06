#!/usr/bin/env tsx
/**
 * Check if node_embeddings table has any data
 */

import pg from 'pg';
const { Pool } = pg;

async function main() {
  const dbUrl = process.env.SUPABASE_POSTGRES_URL || process.env.DATABASE_URL;
  
  if (!dbUrl) {
    console.error('❌ No database URL found in environment');
    console.error('   Set SUPABASE_POSTGRES_URL or DATABASE_URL');
    process.exit(1);
  }
  
  console.log('🔍 Connecting to database...\n');
  
  const pool = new Pool({ connectionString: dbUrl });
  
  try {
    // Check if table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'node_embeddings'
      );
    `);
    
    if (!tableCheck.rows[0].exists) {
      console.log('❌ node_embeddings table does not exist');
      process.exit(1);
    }
    
    console.log('✅ node_embeddings table exists\n');
    
    // Count rows
    const countResult = await pool.query('SELECT count(*) FROM node_embeddings');
    const count = parseInt(countResult.rows[0].count);
    
    console.log(`📊 Total embeddings: ${count}\n`);
    
    if (count > 0) {
      // Show recent entries
      const recentResult = await pool.query(`
        SELECT node_id, model, dim, 
               substring(summary, 1, 80) as summary_preview,
               updated_at
        FROM node_embeddings 
        ORDER BY updated_at DESC 
        LIMIT 5
      `);
      
      console.log('📝 Recent embeddings:');
      for (const row of recentResult.rows) {
        console.log(`\n  Node ID: ${row.node_id}`);
        console.log(`  Model: ${row.model}`);
        console.log(`  Dimensions: ${row.dim}`);
        console.log(`  Summary: ${row.summary_preview}...`);
        console.log(`  Updated: ${row.updated_at}`);
      }
    } else {
      console.log('⚠️  No embeddings found in database');
    }
    
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);

