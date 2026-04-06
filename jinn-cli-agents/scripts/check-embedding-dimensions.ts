#!/usr/bin/env tsx
/**
 * Check embedding dimensions in node_embeddings table
 */

import { Pool } from 'pg';
import 'dotenv/config';

async function main() {
  const connectionString = process.env.SUPABASE_POSTGRES_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ No database URL configured');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  
  try {
    console.log('🔍 Checking embedding dimensions in node_embeddings...\n');
    
    // Count by dimension
    const dimQuery = `
      SELECT dim, COUNT(*) as count
      FROM node_embeddings
      GROUP BY dim
      ORDER BY dim;
    `;
    const dimResult = await pool.query(dimQuery);
    
    if (dimResult.rows.length === 0) {
      console.log('ℹ️ No embeddings found in database.');
    } else {
      console.log('📊 Embedding dimensions:');
      console.table(dimResult.rows);
    }
    
    // Show recent embeddings with dimensions
    const recentQuery = `
      SELECT node_id, model, dim, substring(summary, 1, 80) as summary_preview, updated_at
      FROM node_embeddings
      ORDER BY updated_at DESC
      LIMIT 10;
    `;
    const recentResult = await pool.query(recentQuery);
    
    if (recentResult.rows.length > 0) {
      console.log('\n📝 Recent embeddings:');
      console.table(recentResult.rows);
    }
    
  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
  } finally {
    await pool.end();
  }
}

main();

