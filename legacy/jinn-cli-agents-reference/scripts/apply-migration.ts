#!/usr/bin/env tsx
/**
 * Apply SQL migration to Supabase database
 * Usage: yarn tsx scripts/apply-migration.ts <migration-file>
 */

import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

async function main() {
  const migrationFile = process.argv[2];
  
  if (!migrationFile) {
    console.error('Usage: yarn tsx scripts/apply-migration.ts <migration-file>');
    console.error('Example: yarn tsx scripts/apply-migration.ts migrations/create_job_templates_table.sql');
    process.exit(1);
  }

  const dbUrl = process.env.SUPABASE_POSTGRES_URL || process.env.DATABASE_URL;
  
  if (!dbUrl) {
    console.error('❌ No database URL found in environment');
    console.error('   Set SUPABASE_POSTGRES_URL or DATABASE_URL');
    process.exit(1);
  }

  const fullPath = path.resolve(process.cwd(), migrationFile);
  
  if (!fs.existsSync(fullPath)) {
    console.error(`❌ Migration file not found: ${fullPath}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(fullPath, 'utf8');
  
  console.log(`📄 Applying migration: ${migrationFile}`);
  console.log(`📊 SQL length: ${sql.length} characters\n`);

  const pool = new Pool({ connectionString: dbUrl });
  
  try {
    await pool.query(sql);
    console.log('✅ Migration applied successfully');
  } catch (err: any) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();

