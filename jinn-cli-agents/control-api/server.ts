// @ts-nocheck
// TODO: Generate proper Supabase Database types to remove @ts-nocheck
// Run: npx supabase gen types typescript --project-id <project-id> > types/database.ts
// Deployed: venture watcher claim gate support
// Deploy trigger: 2026-02-15T10:32
import { createYoga, createSchema } from 'graphql-yoga';
import { GraphQLError } from 'graphql';
import { createClient } from '@supabase/supabase-js';
import fetch from 'cross-fetch';
import dotenv from 'dotenv';
import { logger, serializeError } from 'jinn-node/logging';
import { config, secrets } from 'jinn-node/config';
import { getMasterSafe, getServiceSafeAddress } from 'jinn-node/env/operate-profile';
import { InMemoryNonceStore, verifyControlApiRequest } from 'jinn-node/http/erc8128';

// Load environment variables
dotenv.config();

type Context = {
  supabase: ReturnType<typeof createClient>;
  ponderUrl: string;
  req: Request;
  verifiedAddress: string | undefined;
};

const typeDefs = /* GraphQL */ `
  type RequestClaim {
    request_id: String!
    worker_address: String!
    status: String!
    claimed_at: String!
    completed_at: String
    alreadyClaimed: Boolean
  }

  type DispatchClaim {
    parent_job_def_id: String!
    allowed: Boolean!
    claimed_by: String
  }

  type VentureDispatchClaim {
    venture_id: String!
    template_id: String!
    schedule_tick: String!
    allowed: Boolean!
    claimed_by: String
  }

  type JobReport {
    id: String!
    request_id: String!
    worker_address: String!
    status: String!
    duration_ms: Int!
    total_tokens: Int
    final_output: String
    error_message: String
    error_type: String
    created_at: String!
  }

  type Artifact {
    id: String!
    request_id: String!
    worker_address: String!
    cid: String!
    topic: String!
    content: String
    created_at: String!
  }

  type Message {
    id: String!
    request_id: String!
    worker_address: String!
    content: String!
    status: String!
    created_at: String!
  }

  type UtilityScore {
    id: String!
    artifact_id: String!
    score: Int!
    access_count: Int!
    created_at: String!
    updated_at: String!
  }

  type JobTemplate {
    id: String!
    name: String!
    description: String
    tags: [String!]!
    enabled_tools_policy: String!
    input_schema: String!
    output_spec: String!
    x402_price: String!
    safety_tier: String!
    status: String!
    canonical_job_definition_id: String
    created_at: String!
    updated_at: String!
  }

  type TransactionRequest {
    id: String!
    request_id: String
    worker_address: String
    chain_id: Int!
    payload: String!
    payload_hash: String!
    execution_strategy: String!
    status: String!
    idempotency_key: String
    safe_tx_hash: String
    tx_hash: String
    error_code: String
    error_message: String
    created_at: String!
    updated_at: String!
  }

  input JobReportInput {
    status: String!
    duration_ms: Int!
    total_tokens: Int
    tools_called: String
    final_output: String
    error_message: String
    error_type: String
    raw_telemetry: String
  }

  input ArtifactInput {
    cid: String!
    topic: String!
    content: String
  }

  input MessageInput {
    content: String!
    status: String
  }

  input JobTemplateInput {
    name: String!
    description: String
    tags: [String!]
    enabled_tools_policy: String
    input_schema: String
    output_spec: String
    x402_price: String
    safety_tier: String
    status: String
    canonical_job_definition_id: String
  }

  # Wishlist Types
  type WishlistWallet {
    id: String!
    address: String!
    public_key: String
    deployed: Boolean!
    total_points: Int!
    created_at: String!
  }

  type Wish {
    id: String!
    wallet_address: String!
    intent: String!
    context: String
    category: String
    upvotes: Int!
    fulfilled_by: String
    fulfilled_at: String
    status: String!
    created_at: String!
    updated_at: String!
  }

  type WishlistPoints {
    id: String!
    wallet_address: String!
    reason: String!
    points: Int!
    wish_id: String
    created_at: String!
  }

  type LeaderboardEntry {
    address: String!
    total_points: Int!
  }

  type WalletStats {
    address: String!
    total_points: Int!
    wishes_created: Int!
    upvotes_given: Int!
    upvotes_received: Int!
    wishes_fulfilled: Int!
  }

  type Mutation {
    claimRequest(requestId: String!): RequestClaim!
    claimParentDispatch(parentJobDefId: String!, childJobDefId: String!): DispatchClaim!
    claimVentureDispatch(ventureId: String!, templateId: String!, scheduleTick: String!): VentureDispatchClaim!
    createJobReport(requestId: String!, reportData: JobReportInput!): JobReport!
    createArtifact(requestId: String!, artifactData: ArtifactInput!): Artifact!
    createMessage(requestId: String!, messageData: MessageInput!): Message!
    rateMemory(artifactId: String!, rating: Int!): UtilityScore!
    enqueueTransaction(requestId: String, chain_id: Int!, execution_strategy: String!, payload: String!, idempotency_key: String): TransactionRequest!
    getTransactionStatus(id: String!): TransactionRequest!
    claimTransactionRequest: TransactionRequest
    updateTransactionStatus(id: String!, status: String!, safe_tx_hash: String, tx_hash: String, error_code: String, error_message: String): TransactionRequest!
    createJobTemplate(id: String!, templateData: JobTemplateInput!): JobTemplate!
    updateJobTemplate(id: String!, templateData: JobTemplateInput!): JobTemplate!

    # Wishlist Mutations
    createWishlistWallet(address: String!, publicKey: String): WishlistWallet!
    createWish(walletAddress: String!, intent: String!, context: String, category: String): Wish!
    upvoteWish(wishId: String!, walletAddress: String!): Wish!
    fulfillWish(wishId: String!, workstreamTemplateId: String!): Wish!
    awardPoints(walletAddress: String!, reason: String!, points: Int!, wishId: String): WishlistPoints!
  }

  type Query {
    _health: String!
    jobTemplates(status: String, safety_tier: String, limit: Int): [JobTemplate!]!
    jobTemplate(id: String!): JobTemplate
    getRequestClaim(requestId: String!): RequestClaim

    # Wishlist Queries
    wishes(status: String, category: String, orderBy: String, limit: Int, offset: Int): [Wish!]!
    wish(id: String!): Wish
    leaderboard(limit: Int): [LeaderboardEntry!]!
    walletStats(address: String!): WalletStats
  }
`;

async function assertRequestExists(ctx: Context, requestId: string) {
  if (!ctx.ponderUrl) return; // allow skip if not configured

  const body = {
    query: `query($id: String!) { request(id: $id) { id } }`,
    variables: { id: requestId },
  };

  try {
    // Add timeout to prevent hanging on slow/unavailable endpoints
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${ctx.ponderUrl}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // If Ponder is unavailable (5xx), skip validation rather than blocking claims
    if (!res.ok) {
      logger.warn({
        requestId,
        status: res.status,
      }, 'Ponder returned non-OK status, skipping validation');
      return;
    }

    // Check if response is actually JSON before parsing
    const contentType = res.headers.get('content-type');
    if (!contentType?.includes('application/json')) {
      logger.warn({
        requestId,
        status: res.status,
        contentType
      }, 'Ponder returned non-JSON response, skipping validation');
      return; // Skip validation rather than failing
    }

    const json = await res.json();
    if (!json?.data?.request?.id) {
      throw new Error(`Unknown request_id: ${requestId}`);
    }
  } catch (error) {
    // Validation failures must be thrown to prevent invalid writes
    logger.error({ error: serializeError(error), requestId }, 'Ponder validation failed');
    throw error;
  }
}

function getWorkerAddress(ctx: Context): string {
  if (!ctx.verifiedAddress) {
    throw new GraphQLError('Authentication required: no verified worker address', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
  return ctx.verifiedAddress;
}

const resolvers = {
  Query: {
    _health: () => 'ok',

    jobTemplates: async (
      _: any,
      args: { status?: string; safety_tier?: string; limit?: number },
      ctx: Context
    ) => {
      let query = ctx.supabase
        .from('job_templates')
        .select('*')
        .order('created_at', { ascending: false });

      if (args.status) {
        query = query.eq('status', args.status);
      }
      if (args.safety_tier) {
        query = query.eq('safety_tier', args.safety_tier);
      }
      if (args.limit) {
        query = query.limit(args.limit);
      }

      const { data, error } = await query;
      if (error) throw new Error(error.message);

      // Transform JSONB fields to strings for GraphQL
      return (data || []).map((t: any) => ({
        ...t,
        tags: t.tags || [],
        enabled_tools_policy: JSON.stringify(t.enabled_tools_policy || []),
        input_schema: JSON.stringify(t.input_schema || {}),
        output_spec: JSON.stringify(t.output_spec || {}),
        x402_price: String(t.x402_price || 0),
      }));
    },

    jobTemplate: async (_: any, args: { id: string }, ctx: Context) => {
      const { data, error } = await ctx.supabase
        .from('job_templates')
        .select('*')
        .eq('id', args.id)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!data) return null;

      return {
        ...data,
        tags: data.tags || [],
        enabled_tools_policy: JSON.stringify(data.enabled_tools_policy || []),
        input_schema: JSON.stringify(data.input_schema || {}),
        output_spec: JSON.stringify(data.output_spec || {}),
        x402_price: String(data.x402_price || 0),
      };
    },

    getRequestClaim: async (_: any, args: { requestId: string }, ctx: Context) => {
      const { data, error } = await ctx.supabase
        .from('onchain_request_claims')
        .select('*')
        .eq('request_id', args.requestId)
        .order('claimed_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw new Error(error.message);
      return data; // Returns null if not found
    },

    // Wishlist Queries
    wishes: async (
      _: any,
      args: { status?: string; category?: string; orderBy?: string; limit?: number; offset?: number },
      ctx: Context
    ) => {
      let query = ctx.supabase
        .from('wishlist_wishes')
        .select('*');

      if (args.status) {
        query = query.eq('status', args.status);
      }
      if (args.category) {
        query = query.eq('category', args.category);
      }

      // Order by: upvotes (default), created_at, or updated_at
      const orderField = args.orderBy === 'created_at' ? 'created_at'
        : args.orderBy === 'updated_at' ? 'updated_at'
        : 'upvotes';
      query = query.order(orderField, { ascending: false });

      if (args.limit) {
        query = query.limit(args.limit);
      }
      if (args.offset) {
        query = query.range(args.offset, args.offset + (args.limit || 50) - 1);
      }

      const { data, error } = await query;
      if (error) throw new Error(error.message);

      return (data || []).map((w: any) => ({
        ...w,
        context: w.context ? JSON.stringify(w.context) : null,
      }));
    },

    wish: async (_: any, args: { id: string }, ctx: Context) => {
      const { data, error } = await ctx.supabase
        .from('wishlist_wishes')
        .select('*')
        .eq('id', args.id)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!data) return null;

      return {
        ...data,
        context: data.context ? JSON.stringify(data.context) : null,
      };
    },

    leaderboard: async (_: any, args: { limit?: number }, ctx: Context) => {
      const limit = args.limit || 100;

      const { data, error } = await ctx.supabase
        .from('wishlist_wallets')
        .select('address, total_points')
        .order('total_points', { ascending: false })
        .limit(limit);

      if (error) throw new Error(error.message);

      return (data || []).map((w: any) => ({
        address: w.address,
        total_points: w.total_points || 0,
      }));
    },

    walletStats: async (_: any, args: { address: string }, ctx: Context) => {
      // Get wallet
      const { data: wallet, error: walletErr } = await ctx.supabase
        .from('wishlist_wallets')
        .select('*')
        .eq('address', args.address)
        .maybeSingle();

      if (walletErr) throw new Error(walletErr.message);
      if (!wallet) return null;

      // Get wish counts
      const { count: wishesCreated } = await ctx.supabase
        .from('wishlist_wishes')
        .select('*', { count: 'exact', head: true })
        .eq('wallet_address', args.address);

      const { count: upvotesGiven } = await ctx.supabase
        .from('wishlist_upvotes')
        .select('*', { count: 'exact', head: true })
        .eq('wallet_address', args.address);

      // Upvotes received = sum of upvotes on wishes created by this wallet
      const { data: wishesData } = await ctx.supabase
        .from('wishlist_wishes')
        .select('upvotes')
        .eq('wallet_address', args.address);
      const upvotesReceived = (wishesData || []).reduce((sum: number, w: any) => sum + (w.upvotes || 0), 0);

      const { count: wishesFulfilled } = await ctx.supabase
        .from('wishlist_wishes')
        .select('*', { count: 'exact', head: true })
        .eq('wallet_address', args.address)
        .eq('status', 'fulfilled');

      return {
        address: args.address,
        total_points: wallet.total_points || 0,
        wishes_created: wishesCreated || 0,
        upvotes_given: upvotesGiven || 0,
        upvotes_received: upvotesReceived,
        wishes_fulfilled: wishesFulfilled || 0,
      };
    },
  },
  Mutation: {
    claimRequest: async (_: any, args: { requestId: string }, ctx: Context) => {
      const worker = getWorkerAddress(ctx);
      logger.info({ requestId: args.requestId, worker }, '>>> claimRequest called');

      await assertRequestExists(ctx, args.requestId);
      const now = new Date().toISOString();
      const staleThreshold = new Date(Date.now() - 300000).toISOString(); // 5 minutes ago

      // Step 1: Try to INSERT a new claim (atomic - will fail if exists)
      const { data: inserted, error: insertErr } = await ctx.supabase
        .from('onchain_request_claims')
        .insert({
          request_id: args.requestId,
          worker_address: worker,
          status: 'IN_PROGRESS',
          claimed_at: now,
          completed_at: null,
        })
        .select('*');

      // If insert succeeded, we claimed it
      if (!insertErr && inserted && inserted.length > 0) {
        return { ...inserted[0], alreadyClaimed: false };
      }

      // If error is NOT a unique constraint violation, throw it
      if (insertErr && insertErr.code !== '23505') {
        throw new Error(insertErr.message);
      }

      // Step 2: Claim already exists - fetch it to check if reclaimable
      const { data: existing, error: fetchErr } = await ctx.supabase
        .from('onchain_request_claims')
        .select('*')
        .eq('request_id', args.requestId)
        .order('claimed_at', { ascending: false })
        .limit(1)
        .single();
      if (fetchErr) throw new Error(fetchErr.message);

      // Step 3: Check if reclaimable (completed or stale)
      const isCompleted = existing.status === 'COMPLETED';
      const isStale = existing.status === 'IN_PROGRESS' &&
        existing.claimed_at && existing.claimed_at < staleThreshold;

      if (!isCompleted && !isStale) {
        // Active claim by another worker - return with alreadyClaimed flag
        logger.info({
          requestId: args.requestId,
          existingStatus: existing.status,
          existingClaimedAt: existing.claimed_at,
          staleThreshold,
          existingWorker: existing.worker_address,
          requestingWorker: worker,
        }, 'Claim NOT reclaimable - returning alreadyClaimed=true');
        return { ...existing, alreadyClaimed: true };
      }

      // Step 4: Reclaim with conditional UPDATE (atomic - guards against races)
      logger.info({
        requestId: args.requestId,
        reason: isCompleted ? 'completed' : 'stale',
        oldWorker: existing.worker_address,
        newWorker: worker,
        existingStatus: existing.status,
        existingClaimedAt: existing.claimed_at,
        staleThreshold,
        orFilter: `status.eq.COMPLETED,claimed_at.lt.${staleThreshold}`,
      }, 'Re-claiming job');

      // Note: We've already verified in Step 3 that the claim is reclaimable.
      // The .or() conditional UPDATE was failing silently, so we use a simple .eq() here.
      // Race condition is acceptable: worst case is two workers both update, but the
      // second update just overwrites with the same IN_PROGRESS status.
      const { data: updated, error: updateErr } = await ctx.supabase
        .from('onchain_request_claims')
        .update({
          worker_address: worker,
          status: 'IN_PROGRESS',
          claimed_at: now,
          completed_at: null,
        })
        .eq('request_id', args.requestId)
        .select('*');

      if (updateErr) throw new Error(updateErr.message);

      logger.info({
        requestId: args.requestId,
        updatedRows: updated?.length || 0,
        updatedData: updated?.[0] ? { claimed_at: updated[0].claimed_at, status: updated[0].status } : null,
      }, 'UPDATE result for re-claim');

      // If update succeeded, we reclaimed it
      if (updated && updated.length > 0) {
        logger.info({ requestId: args.requestId }, 'Re-claim succeeded - returning alreadyClaimed=false');
        return { ...updated[0], alreadyClaimed: false };
      }

      // Lost the race - another worker reclaimed it first
      logger.info({ requestId: args.requestId }, 'Re-claim failed (lost race) - returning alreadyClaimed=true');
      const { data: refreshed } = await ctx.supabase
        .from('onchain_request_claims')
        .select('*')
        .eq('request_id', args.requestId)
        .order('claimed_at', { ascending: false })
        .limit(1)
        .single();
      return { ...refreshed, alreadyClaimed: true };
    },

    claimParentDispatch: async (_: any, args: { parentJobDefId: string; childJobDefId: string }, ctx: Context) => {
      const worker = getWorkerAddress(ctx);
      const now = new Date().toISOString();
      const expirationDate = new Date();
      // 5 minutes from now
      expirationDate.setMinutes(expirationDate.getMinutes() + 5);
      const expiresAt = expirationDate.toISOString();

      // Step 0: Clean up expired claims (maintenance)
      // We don't await this to keep latency low, just fire and forget or let background process handle
      // But for strict correctness, we should clear expired for *this* parent before checking
      await ctx.supabase
        .from('parent_dispatch_claims')
        .delete()
        .lt('expires_at', now)
        .eq('parent_job_def_id', args.parentJobDefId);

      // Step 1: Try INSERT (atomic claim)
      const { data: inserted, error: insertErr } = await ctx.supabase
        .from('parent_dispatch_claims')
        .insert({
          parent_job_def_id: args.parentJobDefId,
          child_job_def_id: args.childJobDefId,
          worker_address: worker,
          claimed_at: now,
          expires_at: expiresAt
        })
        .select('*');

      // Success - we claimed it
      if (!insertErr && inserted && inserted.length > 0) {
        logger.info({
          parent: args.parentJobDefId,
          child: args.childJobDefId,
          worker
        }, 'Claimed parent dispatch');
        return {
          parent_job_def_id: args.parentJobDefId,
          allowed: true,
          claimed_by: args.childJobDefId // It's us
        };
      }

      // Error - likely already claimed
      if (insertErr && insertErr.code === '23505') { // Unique violation
        // Fetch existing to see who claimed it
        const { data: existing } = await ctx.supabase
          .from('parent_dispatch_claims')
          .select('child_job_def_id')
          .eq('parent_job_def_id', args.parentJobDefId)
          .single();

        const owner = existing?.child_job_def_id || 'unknown';

        // If WE already claimed it (e.g. retry), allow it
        if (owner === args.childJobDefId) {
          return {
            parent_job_def_id: args.parentJobDefId,
            allowed: true,
            claimed_by: owner
          };
        }

        logger.info({
          parent: args.parentJobDefId,
          child: args.childJobDefId,
          existingOwner: owner
        }, 'Parent dispatch already claimed by sibling');

        return {
          parent_job_def_id: args.parentJobDefId,
          allowed: false,
          claimed_by: owner
        };
      }

      // Other error
      logger.error({ error: insertErr.message }, 'Error claiming parent dispatch');
      throw new Error(insertErr.message);
    },

    claimVentureDispatch: async (
      _: any,
      args: { ventureId: string; templateId: string; scheduleTick: string },
      ctx: Context
    ) => {
      const worker = getWorkerAddress(ctx);
      const now = new Date().toISOString();
      const expirationDate = new Date();
      expirationDate.setMinutes(expirationDate.getMinutes() + 10);
      const expiresAt = expirationDate.toISOString();

      // Step 0: Clean up expired claims for this venture+template
      await ctx.supabase
        .from('venture_dispatch_claims')
        .delete()
        .lt('expires_at', now)
        .eq('venture_id', args.ventureId)
        .eq('template_id', args.templateId);

      // Step 1: Try INSERT (atomic claim via unique constraint)
      const { data: inserted, error: insertErr } = await ctx.supabase
        .from('venture_dispatch_claims')
        .insert({
          venture_id: args.ventureId,
          template_id: args.templateId,
          schedule_tick: args.scheduleTick,
          worker_address: worker,
          claimed_at: now,
          expires_at: expiresAt,
        })
        .select('*');

      // Success — we claimed it
      if (!insertErr && inserted && inserted.length > 0) {
        logger.info({
          ventureId: args.ventureId,
          templateId: args.templateId,
          scheduleTick: args.scheduleTick,
          worker,
        }, 'Claimed venture dispatch');
        return {
          venture_id: args.ventureId,
          template_id: args.templateId,
          schedule_tick: args.scheduleTick,
          allowed: true,
          claimed_by: worker,
        };
      }

      // Unique constraint violation — another worker claimed it
      if (insertErr && insertErr.code === '23505') {
        const { data: existing } = await ctx.supabase
          .from('venture_dispatch_claims')
          .select('worker_address')
          .eq('venture_id', args.ventureId)
          .eq('template_id', args.templateId)
          .eq('schedule_tick', args.scheduleTick)
          .single();

        const owner = existing?.worker_address || 'unknown';

        // If WE already claimed it (e.g. retry), allow it
        if (owner === worker) {
          return {
            venture_id: args.ventureId,
            template_id: args.templateId,
            schedule_tick: args.scheduleTick,
            allowed: true,
            claimed_by: owner,
          };
        }

        logger.info({
          ventureId: args.ventureId,
          templateId: args.templateId,
          scheduleTick: args.scheduleTick,
          existingOwner: owner,
        }, 'Venture dispatch already claimed by another worker');

        return {
          venture_id: args.ventureId,
          template_id: args.templateId,
          schedule_tick: args.scheduleTick,
          allowed: false,
          claimed_by: owner,
        };
      }

      // Other error
      logger.error({ error: insertErr?.message }, 'Error claiming venture dispatch');
      throw new Error(insertErr?.message || 'Unknown error claiming venture dispatch');
    },

    createJobReport: async (
      _: any,
      args: { requestId: string; reportData: any },
      ctx: Context
    ) => {
      await assertRequestExists(ctx, args.requestId);
      const worker = getWorkerAddress(ctx);

      // Map intermediate statuses to valid database values
      // DB constraint only allows 'COMPLETED' and 'FAILED'
      const reportStatusMap: Record<string, string> = {
        'COMPLETED': 'COMPLETED',
        'FAILED': 'FAILED',
        'DELEGATING': 'COMPLETED', // Job completed by delegating to children
        'WAITING': 'COMPLETED',    // Job completed its phase, waiting for dependencies
        'IN_PROGRESS': 'COMPLETED', // Treat as completed for reporting purposes
      };
      const dbStatus = reportStatusMap[args.reportData.status] || 'COMPLETED';

      const payload = {
        request_id: args.requestId,
        worker_address: worker,
        status: dbStatus,
        duration_ms: args.reportData.duration_ms,
        total_tokens: args.reportData.total_tokens ?? 0,
        tools_called: args.reportData.tools_called ?? '[]',
        final_output: args.reportData.final_output ?? null,
        error_message: args.reportData.error_message ?? null,
        error_type: args.reportData.error_type ?? null,
        raw_telemetry: args.reportData.raw_telemetry ?? '{}',
      };

      const { data, error } = await ctx.supabase
        .from('onchain_job_reports')
        .upsert(payload, { onConflict: 'request_id' })
        .select()
        .limit(1);
      if (error) {
        logger.error({
          requestId: args.requestId,
          status: payload.status,
          error: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code
        }, 'Failed to upsert job report');
        throw new Error(`createJobReport failed: ${error.message} (requestId=${args.requestId}, status=${payload.status})`);
      }
      const report = data![0];

      // Update claim status based on report outcome
      // Map job statuses to valid claim statuses
      const claimStatusMap: Record<string, string> = {
        'DELEGATING': 'IN_PROGRESS',
        'WAITING': 'IN_PROGRESS',
        'COMPLETED': 'COMPLETED',
        'FAILED': 'COMPLETED', // Claims track work completion, not success/failure
        'IN_PROGRESS': 'IN_PROGRESS',
      };
      const finalStatus = claimStatusMap[payload.status] || 'COMPLETED';
      const patch: any = {
        status: finalStatus,
        completed_at: new Date().toISOString(),
      };
      const { error: updErr } = await ctx.supabase
        .from('onchain_request_claims')
        .update(patch)
        .eq('request_id', args.requestId);
      if (updErr) logger.error({ error: updErr.message, requestId: args.requestId }, 'Failed to update claim status');

      return report;
    },

    createArtifact: async (
      _: any,
      args: { requestId: string; artifactData: any },
      ctx: Context
    ) => {
      await assertRequestExists(ctx, args.requestId);
      const worker = getWorkerAddress(ctx);

      const payload = {
        request_id: args.requestId,
        worker_address: worker,
        cid: args.artifactData.cid,
        topic: args.artifactData.topic,
        content: args.artifactData.content ?? null,
      };

      const { data, error } = await ctx.supabase
        .from('onchain_artifacts')
        .insert(payload)
        .select()
        .limit(1);
      if (error) throw new Error(error.message);
      return data![0];
    },

    createMessage: async (
      _: any,
      args: { requestId: string; messageData: any },
      ctx: Context
    ) => {
      await assertRequestExists(ctx, args.requestId);
      const worker = getWorkerAddress(ctx);

      const payload = {
        request_id: args.requestId,
        worker_address: worker,
        content: args.messageData.content,
        status: args.messageData.status ?? 'PENDING',
      };

      const { data, error } = await ctx.supabase
        .from('onchain_messages')
        .insert(payload)
        .select()
        .limit(1);
      if (error) throw new Error(error.message);
      return data![0];
    },

    rateMemory: async (
      _: any,
      args: { artifactId: string; rating: number },
      ctx: Context
    ) => {
      // Validate rating is either +1 or -1
      if (args.rating !== 1 && args.rating !== -1) {
        throw new Error('Rating must be either +1 (useful) or -1 (not useful)');
      }

      // Check if record exists
      const { data: existing, error: exErr } = await ctx.supabase
        .from('utility_scores')
        .select('*')
        .eq('artifact_id', args.artifactId)
        .limit(1);

      if (exErr) throw new Error(exErr.message);

      if (existing && existing.length > 0) {
        // Update existing score
        const current = existing[0];
        const newScore = (current.score || 0) + args.rating;
        const newAccessCount = (current.access_count || 0) + 1;

        const { data, error } = await ctx.supabase
          .from('utility_scores')
          .update({
            score: newScore,
            access_count: newAccessCount,
            updated_at: new Date().toISOString(),
          })
          .eq('artifact_id', args.artifactId)
          .select()
          .limit(1);

        if (error) throw new Error(error.message);
        return data![0];
      } else {
        // Create new score record
        const { data, error } = await ctx.supabase
          .from('utility_scores')
          .insert({
            artifact_id: args.artifactId,
            score: args.rating,
            access_count: 1,
          })
          .select()
          .limit(1);

        if (error) throw new Error(error.message);
        return data![0];
      }
    },

    enqueueTransaction: async (
      _: any,
      args: { requestId?: string; chain_id: number; execution_strategy: string; payload: string; idempotency_key?: string },
      ctx: Context
    ) => {
      const worker = getWorkerAddress(ctx);
      if (args.requestId) {
        await assertRequestExists(ctx, args.requestId);
      }

      // Parse payload JSON string
      let parsedPayload: any;
      try {
        parsedPayload = JSON.parse(args.payload);
      } catch (e) {
        throw new Error('Invalid payload: must be JSON string');
      }

      const insert = {
        request_id: args.requestId ?? null,
        worker_address: worker,
        chain_id: args.chain_id,
        payload: parsedPayload,
        payload_hash: '', // optionally computed by client; keep server simple
        execution_strategy: args.execution_strategy,
        idempotency_key: args.idempotency_key ?? null,
      } as any;

      const { data, error } = await ctx.supabase
        .from('onchain_transaction_requests')
        .insert(insert)
        .select()
        .limit(1);
      if (error) throw new Error(error.message);
      return data![0];
    },

    getTransactionStatus: async (
      _: any,
      args: { id: string },
      ctx: Context
    ) => {
      const { data, error } = await ctx.supabase
        .from('onchain_transaction_requests')
        .select('*')
        .eq('id', args.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error('Not found');
      return data;
    },

    // Atomically claim the oldest pending transaction request
    claimTransactionRequest: async (_: any, __: any, ctx: Context) => {
      const worker = getWorkerAddress(ctx);
      // 1) Select a candidate to claim (oldest pending, no worker)
      const { data: candidates, error: selErr } = await ctx.supabase
        .from('onchain_transaction_requests')
        .select('id')
        .eq('status', 'PENDING')
        .is('worker_address', null)
        .order('created_at', { ascending: true })
        .limit(1);
      if (selErr) throw new Error(selErr.message);
      const candidate = candidates?.[0]?.id;
      if (!candidate) return null;

      // 2) Attempt conditional update to avoid races
      const { data: updated, error: updErr } = await ctx.supabase
        .from('onchain_transaction_requests')
        .update({ status: 'IN_PROGRESS', worker_address: worker, updated_at: new Date().toISOString() })
        .eq('id', candidate)
        .eq('status', 'PENDING')
        .is('worker_address', null)
        .select('*')
        .limit(1);
      if (updErr) throw new Error(updErr.message);
      if (!updated || updated.length === 0) return null; // Lost the race
      return updated[0];
    },

    updateTransactionStatus: async (
      _: any,
      args: { id: string; status: string; safe_tx_hash?: string; tx_hash?: string; error_code?: string; error_message?: string },
      ctx: Context
    ) => {
      const patch: any = {
        status: args.status,
        updated_at: new Date().toISOString(),
      };
      if (args.safe_tx_hash !== undefined) patch.safe_tx_hash = args.safe_tx_hash;
      if (args.tx_hash !== undefined) patch.tx_hash = args.tx_hash;
      if (args.error_code !== undefined) patch.error_code = args.error_code;
      if (args.error_message !== undefined) patch.error_message = args.error_message;
      if (args.status === 'FAILED' || args.status === 'CONFIRMED') {
        patch.completed_at = new Date().toISOString();
      }

      const { data, error } = await ctx.supabase
        .from('onchain_transaction_requests')
        .update(patch)
        .eq('id', args.id)
        .select('*')
        .limit(1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) throw new Error('Not found');
      return data[0];
    },

    createJobTemplate: async (
      _: any,
      args: { id: string; templateData: any },
      ctx: Context
    ) => {
      const payload: any = {
        id: args.id,
        name: args.templateData.name,
        description: args.templateData.description ?? null,
        tags: args.templateData.tags ?? [],
        enabled_tools_policy: args.templateData.enabled_tools_policy
          ? JSON.parse(args.templateData.enabled_tools_policy)
          : [],
        input_schema: args.templateData.input_schema
          ? JSON.parse(args.templateData.input_schema)
          : {},
        output_spec: args.templateData.output_spec
          ? JSON.parse(args.templateData.output_spec)
          : {},
        x402_price: args.templateData.x402_price
          ? BigInt(args.templateData.x402_price)
          : 0,
        safety_tier: args.templateData.safety_tier ?? 'public',
        status: args.templateData.status ?? 'visible',
        canonical_job_definition_id: args.templateData.canonical_job_definition_id ?? null,
      };

      const { data, error } = await ctx.supabase
        .from('job_templates')
        .insert(payload)
        .select()
        .limit(1);
      if (error) throw new Error(error.message);

      const t = data![0];
      return {
        ...t,
        tags: t.tags || [],
        enabled_tools_policy: JSON.stringify(t.enabled_tools_policy || []),
        input_schema: JSON.stringify(t.input_schema || {}),
        output_spec: JSON.stringify(t.output_spec || {}),
        x402_price: String(t.x402_price || 0),
      };
    },

    updateJobTemplate: async (
      _: any,
      args: { id: string; templateData: any },
      ctx: Context
    ) => {
      const patch: any = {};

      if (args.templateData.name !== undefined) patch.name = args.templateData.name;
      if (args.templateData.description !== undefined) patch.description = args.templateData.description;
      if (args.templateData.tags !== undefined) patch.tags = args.templateData.tags;
      if (args.templateData.enabled_tools_policy !== undefined) {
        patch.enabled_tools_policy = JSON.parse(args.templateData.enabled_tools_policy);
      }
      if (args.templateData.input_schema !== undefined) {
        patch.input_schema = JSON.parse(args.templateData.input_schema);
      }
      if (args.templateData.output_spec !== undefined) {
        patch.output_spec = JSON.parse(args.templateData.output_spec);
      }
      if (args.templateData.x402_price !== undefined) {
        patch.x402_price = BigInt(args.templateData.x402_price);
      }
      if (args.templateData.safety_tier !== undefined) patch.safety_tier = args.templateData.safety_tier;
      if (args.templateData.status !== undefined) patch.status = args.templateData.status;
      if (args.templateData.canonical_job_definition_id !== undefined) {
        patch.canonical_job_definition_id = args.templateData.canonical_job_definition_id;
      }

      const { data, error } = await ctx.supabase
        .from('job_templates')
        .update(patch)
        .eq('id', args.id)
        .select()
        .limit(1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) throw new Error('Template not found');

      const t = data[0];
      return {
        ...t,
        tags: t.tags || [],
        enabled_tools_policy: JSON.stringify(t.enabled_tools_policy || []),
        input_schema: JSON.stringify(t.input_schema || {}),
        output_spec: JSON.stringify(t.output_spec || {}),
        x402_price: String(t.x402_price || 0),
      };
    },

    // Wishlist Mutations
    createWishlistWallet: async (
      _: any,
      args: { address: string; publicKey?: string },
      ctx: Context
    ) => {
      const payload = {
        address: args.address,
        public_key: args.publicKey ?? null,
        deployed: false,
        total_points: 0,
      };

      const { data, error } = await ctx.supabase
        .from('wishlist_wallets')
        .insert(payload)
        .select()
        .limit(1);

      if (error) {
        // If duplicate, return existing
        if (error.code === '23505') {
          const { data: existing } = await ctx.supabase
            .from('wishlist_wallets')
            .select('*')
            .eq('address', args.address)
            .single();
          return existing;
        }
        throw new Error(error.message);
      }

      return data![0];
    },

    createWish: async (
      _: any,
      args: { walletAddress: string; intent: string; context?: string; category?: string },
      ctx: Context
    ) => {
      // Ensure wallet exists
      const { data: wallet } = await ctx.supabase
        .from('wishlist_wallets')
        .select('address')
        .eq('address', args.walletAddress)
        .maybeSingle();

      if (!wallet) {
        throw new Error(`Wallet not found: ${args.walletAddress}`);
      }

      const payload = {
        wallet_address: args.walletAddress,
        intent: args.intent,
        context: args.context ? JSON.parse(args.context) : {},
        category: args.category ?? null,
        upvotes: 0,
        status: 'pending',
      };

      const { data, error } = await ctx.supabase
        .from('wishlist_wishes')
        .insert(payload)
        .select()
        .limit(1);

      if (error) throw new Error(error.message);

      const wish = data![0];

      // Award 10 points for creating a wish
      await ctx.supabase.from('wishlist_points').insert({
        wallet_address: args.walletAddress,
        reason: 'wish_created',
        points: 10,
        wish_id: wish.id,
      });

      // Update wallet total points
      await ctx.supabase
        .from('wishlist_wallets')
        .update({ total_points: wallet.total_points + 10 })
        .eq('address', args.walletAddress);

      return {
        ...wish,
        context: wish.context ? JSON.stringify(wish.context) : null,
      };
    },

    upvoteWish: async (
      _: any,
      args: { wishId: string; walletAddress: string },
      ctx: Context
    ) => {
      // Ensure upvoter wallet exists
      const { data: voterWallet } = await ctx.supabase
        .from('wishlist_wallets')
        .select('address')
        .eq('address', args.walletAddress)
        .maybeSingle();

      if (!voterWallet) {
        throw new Error(`Wallet not found: ${args.walletAddress}`);
      }

      // Get the wish
      const { data: wish, error: wishErr } = await ctx.supabase
        .from('wishlist_wishes')
        .select('*')
        .eq('id', args.wishId)
        .single();

      if (wishErr || !wish) {
        throw new Error(`Wish not found: ${args.wishId}`);
      }

      // Prevent self-upvoting
      if (wish.wallet_address === args.walletAddress) {
        throw new Error('Cannot upvote your own wish');
      }

      // Try to insert upvote (will fail if already exists due to unique constraint)
      const { error: upvoteErr } = await ctx.supabase
        .from('wishlist_upvotes')
        .insert({
          wish_id: args.wishId,
          wallet_address: args.walletAddress,
        });

      if (upvoteErr) {
        if (upvoteErr.code === '23505') {
          throw new Error('Already upvoted this wish');
        }
        throw new Error(upvoteErr.message);
      }

      // Increment upvote count on wish
      const newUpvotes = (wish.upvotes || 0) + 1;
      const { data: updatedWish, error: updateErr } = await ctx.supabase
        .from('wishlist_wishes')
        .update({ upvotes: newUpvotes })
        .eq('id', args.wishId)
        .select()
        .limit(1);

      if (updateErr) throw new Error(updateErr.message);

      // Award 1 point to the wish creator for receiving an upvote
      await ctx.supabase.from('wishlist_points').insert({
        wallet_address: wish.wallet_address,
        reason: 'upvote_received',
        points: 1,
        wish_id: args.wishId,
      });

      // Update wish creator's total points
      const { data: creatorWallet } = await ctx.supabase
        .from('wishlist_wallets')
        .select('total_points')
        .eq('address', wish.wallet_address)
        .single();

      if (creatorWallet) {
        await ctx.supabase
          .from('wishlist_wallets')
          .update({ total_points: (creatorWallet.total_points || 0) + 1 })
          .eq('address', wish.wallet_address);
      }

      const result = updatedWish![0];
      return {
        ...result,
        context: result.context ? JSON.stringify(result.context) : null,
      };
    },

    fulfillWish: async (
      _: any,
      args: { wishId: string; workstreamTemplateId: string },
      ctx: Context
    ) => {
      // Get the wish
      const { data: wish, error: wishErr } = await ctx.supabase
        .from('wishlist_wishes')
        .select('*')
        .eq('id', args.wishId)
        .single();

      if (wishErr || !wish) {
        throw new Error(`Wish not found: ${args.wishId}`);
      }

      if (wish.status === 'fulfilled') {
        throw new Error('Wish already fulfilled');
      }

      // Verify the template exists
      const { data: template } = await ctx.supabase
        .from('job_templates')
        .select('id')
        .eq('id', args.workstreamTemplateId)
        .maybeSingle();

      if (!template) {
        throw new Error(`Template not found: ${args.workstreamTemplateId}`);
      }

      // Update wish to fulfilled
      const { data: updatedWish, error: updateErr } = await ctx.supabase
        .from('wishlist_wishes')
        .update({
          status: 'fulfilled',
          fulfilled_by: args.workstreamTemplateId,
          fulfilled_at: new Date().toISOString(),
        })
        .eq('id', args.wishId)
        .select()
        .limit(1);

      if (updateErr) throw new Error(updateErr.message);

      // Award 50 points to the wish creator
      await ctx.supabase.from('wishlist_points').insert({
        wallet_address: wish.wallet_address,
        reason: 'fulfilled',
        points: 50,
        wish_id: args.wishId,
      });

      // Update wallet total points
      const { data: wallet } = await ctx.supabase
        .from('wishlist_wallets')
        .select('total_points')
        .eq('address', wish.wallet_address)
        .single();

      if (wallet) {
        await ctx.supabase
          .from('wishlist_wallets')
          .update({ total_points: (wallet.total_points || 0) + 50 })
          .eq('address', wish.wallet_address);
      }

      const result = updatedWish![0];
      return {
        ...result,
        context: result.context ? JSON.stringify(result.context) : null,
      };
    },

    awardPoints: async (
      _: any,
      args: { walletAddress: string; reason: string; points: number; wishId?: string },
      ctx: Context
    ) => {
      // Validate reason
      const validReasons = ['wish_created', 'upvote_received', 'fulfilled', 'executed', 'referral'];
      if (!validReasons.includes(args.reason)) {
        throw new Error(`Invalid reason. Must be one of: ${validReasons.join(', ')}`);
      }

      // Ensure wallet exists
      const { data: wallet } = await ctx.supabase
        .from('wishlist_wallets')
        .select('total_points')
        .eq('address', args.walletAddress)
        .maybeSingle();

      if (!wallet) {
        throw new Error(`Wallet not found: ${args.walletAddress}`);
      }

      // Insert points record
      const { data, error } = await ctx.supabase
        .from('wishlist_points')
        .insert({
          wallet_address: args.walletAddress,
          reason: args.reason,
          points: args.points,
          wish_id: args.wishId ?? null,
        })
        .select()
        .limit(1);

      if (error) throw new Error(error.message);

      // Update wallet total points
      await ctx.supabase
        .from('wishlist_wallets')
        .update({ total_points: (wallet.total_points || 0) + args.points })
        .eq('address', args.walletAddress);

      return data![0];
    },
  },
};

const schema = createSchema({ typeDefs, resolvers });

const SUPABASE_URL = secrets.supabaseUrl;
const SUPABASE_SERVICE_ROLE_KEY = secrets.supabaseServiceRoleKey;
const PONDER_GRAPHQL_URL = config.services.ponderUrl;
// Railway sets PORT env var, fallback to CONTROL_API_PORT or 4001
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : (parseInt(process.env.CONTROL_API_PORT || '', 10) || 4001);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  logger.fatal('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const nonceStore = new InMemoryNonceStore();

const yoga = createYoga<Context>({
  schema,
  context: async ({ request }) => {
    // Try ERC-8128 signed auth first
    const hasSignature = request.headers.has('signature');
    if (hasSignature) {
      const result = await verifyControlApiRequest(request.clone(), nonceStore);
      if (!result.ok) {
        logger.warn({
          reason: result.reason,
          detail: result.detail,
          method: request.method,
          url: request.url,
          userAgent: request.headers.get('user-agent'),
          xForwardedFor: request.headers.get('x-forwarded-for'),
          hasSignature: !!request.headers.get('signature'),
          hasWorkerAddr: !!request.headers.get('x-worker-address'),
        }, 'ERC-8128 auth failed');
        throw new Error(`ERC-8128 auth failed: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`);
      }
      return {
        supabase,
        ponderUrl: PONDER_GRAPHQL_URL,
        req: request,
        verifiedAddress: result.address,
      };
    }

    // Legacy fallback removed — bare X-Worker-Address is no longer accepted.
    // Mutations that call getWorkerAddress() will throw UNAUTHENTICATED if verifiedAddress is undefined.
    const workerAddress = request.headers.get('x-worker-address');
    if (workerAddress) {
      logger.warn({ workerAddress }, 'Rejected legacy auth: bare X-Worker-Address without ERC-8128 signature');
    }

    // No auth — only introspection/health queries work without a verified address
    return {
      supabase,
      ponderUrl: PONDER_GRAPHQL_URL,
      req: request,
      verifiedAddress: undefined,
    };
  },
  graphqlEndpoint: '/graphql',
});

const http = await import('http');

// Track server start time for uptime reporting
const serverStartTime = new Date();

/**
 * Get abbreviated node ID from master safe address
 * Uses first 8 chars of the safe address (after 0x)
 */
function getNodeId(): string {
  const envNodeId = process.env.JINN_NODE_ID;
  if (envNodeId) return envNodeId;

  const masterSafe = getMasterSafe('base');
  if (masterSafe?.startsWith('0x')) return masterSafe.slice(2, 10).toLowerCase();

  const serviceSafe = getServiceSafeAddress();
  if (serviceSafe?.startsWith('0x')) return serviceSafe.slice(2, 10).toLowerCase();

  return 'unknown';
}

const server = http.createServer((req, res) => {
  // REST /health endpoint for easy monitoring
  if (req.url === '/health' && req.method === 'GET') {
    const now = new Date();
    const uptimeMs = now.getTime() - serverStartTime.getTime();
    const nodeId = getNodeId();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      status: 'ok',
      nodeId,
      service: 'control-api',
      uptime: {
        ms: uptimeMs,
        human: formatDuration(uptimeMs),
      },
      timestamp: now.toISOString(),
    }));
    return;
  }

  // Handle all other requests with Yoga
  yoga(req, res);
});

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Jinn Control API running on http://localhost:${PORT}/graphql`);
});
