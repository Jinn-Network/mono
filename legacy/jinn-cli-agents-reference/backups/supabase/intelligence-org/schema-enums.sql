-- Custom ENUM types for intelligence-org database
-- Backed up: 2025-11-25

CREATE TYPE public.dispatch_trigger_type AS ENUM ('on_new_artifact', 'on_artifact_status_change', 'on_job_status_change', 'one-off', 'on_new_research_thread', 'on_research_thread_update', 'on_processing_time_update');

CREATE TYPE public.execution_strategy AS ENUM ('EOA', 'SAFE');

CREATE TYPE public.request_status AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

CREATE TYPE public.transaction_error_code AS ENUM ('ALLOWLIST_VIOLATION', 'CHAIN_MISMATCH', 'INVALID_PAYLOAD', 'INSUFFICIENT_FUNDS', 'RPC_FAILURE', 'SAFE_TX_REVERT', 'UNKNOWN', 'UNKNOWN_STRATEGY', 'ROUTING_ERROR', 'EXECUTION_STRATEGY_VIOLATION', 'EXECUTION_STRATEGY_MISMATCH');

CREATE TYPE public.transaction_status AS ENUM ('PENDING', 'CLAIMED', 'CONFIRMED', 'FAILED');















