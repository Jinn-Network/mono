-- Migration: Create node_embeddings table for semantic situation search
-- Enables pgvector extensions and stores node-level embeddings keyed by job requestId

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS node_embeddings (
  node_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec VECTOR(256) NOT NULL,
  summary TEXT,
  meta JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS node_embeddings_vec_idx
  ON node_embeddings USING ivfflat (vec vector_cosine_ops)
  WITH (lists = 100);
