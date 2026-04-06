/**
 * Workstream Creator Service
 *
 * Standalone service that converts top-voted wishes into Jinn workstream templates.
 * Runs every 3 hours (configurable via WORKSTREAM_CREATOR_INTERVAL_MS).
 */

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../logging/index.js';
import {
  getRequiredSupabaseUrl,
  getRequiredSupabaseServiceRoleKey,
} from '../../config/index.js';
import { runWorkstreamCreator, startWorkstreamCreator } from './workstream-creator.js';

// Load environment variables
dotenv.config();

const SUPABASE_URL = getRequiredSupabaseUrl();
const SUPABASE_SERVICE_ROLE_KEY = getRequiredSupabaseServiceRoleKey();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  logger.fatal('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Start the service
logger.info('[WorkstreamCreator] Service starting...');
startWorkstreamCreator(supabase);

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('[WorkstreamCreator] Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('[WorkstreamCreator] Shutting down...');
  process.exit(0);
});
