// SPDX-License-Identifier: Apache-2.0

export const INDEX_SCHEMA_VERSION = 1 as const;

/**
 * `unicode61` treats every non-alphanumeric character as a separator, so `snake_case`,
 * dotted, and slashed identifiers tokenize correctly with no help. camelCase is closed
 * product-side by `expandIdentifiers` into the `*_idents` columns. `trigram` is rejected
 * for v1: it is optional in some SQLite builds (see the in-repo precedent's dedicated
 * error branch at `apps/jinn-agent/hermes_state.py:992`), doubles the index, and its
 * three-character minimum degrades short terms. CJK segmentation is consequently
 * unsupported in v1, and the index is rebuildable, so the choice is reversible.
 */
export const INDEX_TOKENIZER = "unicode61 remove_diacritics 2" as const;

export const INDEX_SCHEMA_SQL = `
CREATE TABLE index_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  tokenizer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Persistent high-water mark: the last time anything was successfully indexed, ever.
  -- Deliberately NOT derived from max(documents.indexed_at) -- that would vanish when the
  -- last document is evicted, making "written before, empty now" indistinguishable from
  -- "never written", which is precisely the distinction the doctor's coherence check needs.
  last_indexed_at TEXT,
  -- How many records the LAST public-plane pass excluded by trust. Persisted for the same
  -- reason as the marker: it is read by a health check long after the pass returned, and it
  -- is the discriminator between an honestly-empty index and one emptied by a trust policy
  -- (an expired policy rejects every producer, so a rebuild cannot repair it).
  excluded_by_trust INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  plane TEXT NOT NULL CHECK (plane IN ('local', 'public')),
  family TEXT NOT NULL,
  digest TEXT NOT NULL,
  summary TEXT NOT NULL,
  origin TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  captured_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'abandoned')),
  excerpts_json TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE UNIQUE INDEX documents_identity_idx ON documents(plane, family, digest);
CREATE INDEX documents_recency_idx ON documents(plane, captured_ms DESC, digest ASC);

CREATE VIRTUAL TABLE document_terms USING fts5(
  summary,
  summary_idents,
  body,
  body_idents,
  tokenize = '${INDEX_TOKENIZER}'
);
`;
