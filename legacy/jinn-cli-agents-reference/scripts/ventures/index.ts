/**
 * Ventures Registry - Shared CRUD Functions
 *
 * This module provides the single source of truth for ventures CRUD operations.
 * Used by:
 * - Frontend (Next.js server actions)
 * - MCP tools (Claude, Gemini)
 * - CLI scripts
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.
 */

// Re-export types
export type { Venture, CreateVentureArgs } from './mint.js';
export type { UpdateVentureArgs } from './update.js';

// Re-export CRUD functions
export {
  createVenture,
  getVenture,
  getVentureBySlug,
  listVentures,
} from './mint.js';

export {
  updateVenture,
  archiveVenture,
  deleteVenture,
} from './update.js';
