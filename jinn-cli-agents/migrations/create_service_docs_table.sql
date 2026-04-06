-- Migration: Create service_docs table
-- Purpose: Store documentation and knowledge base entries for services

CREATE TABLE IF NOT EXISTS service_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('readme', 'guide', 'reference', 'tutorial', 'changelog', 'api', 'architecture', 'runbook', 'other')),
  content TEXT NOT NULL,                    -- Markdown content
  content_format TEXT DEFAULT 'markdown' CHECK (content_format IN ('markdown', 'html', 'plaintext')),

  -- Organization
  parent_id UUID REFERENCES service_docs(id) ON DELETE SET NULL,
  sort_order INTEGER DEFAULT 0,

  -- Metadata
  author TEXT,
  version TEXT,
  external_url TEXT,                        -- Link to external documentation

  config JSONB DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  status TEXT DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(service_id, slug)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_service_docs_service_id ON service_docs(service_id);
CREATE INDEX IF NOT EXISTS idx_service_docs_slug ON service_docs(slug);
CREATE INDEX IF NOT EXISTS idx_service_docs_doc_type ON service_docs(doc_type);
CREATE INDEX IF NOT EXISTS idx_service_docs_parent_id ON service_docs(parent_id);
CREATE INDEX IF NOT EXISTS idx_service_docs_status ON service_docs(status);
CREATE INDEX IF NOT EXISTS idx_service_docs_tags ON service_docs USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_service_docs_sort_order ON service_docs(service_id, sort_order);

-- Full-text search on title and content
CREATE INDEX IF NOT EXISTS idx_service_docs_search ON service_docs USING GIN(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')));

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_service_docs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS service_docs_updated_at ON service_docs;
CREATE TRIGGER service_docs_updated_at
  BEFORE UPDATE ON service_docs
  FOR EACH ROW
  EXECUTE FUNCTION update_service_docs_updated_at();

-- Trigger to set published_at when status changes to published
CREATE OR REPLACE FUNCTION set_service_docs_published_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'published' AND (OLD.status IS NULL OR OLD.status != 'published') THEN
    NEW.published_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS service_docs_published_at ON service_docs;
CREATE TRIGGER service_docs_published_at
  BEFORE INSERT OR UPDATE ON service_docs
  FOR EACH ROW
  EXECUTE FUNCTION set_service_docs_published_at();

-- Comments for documentation
COMMENT ON TABLE service_docs IS 'Documentation and knowledge base entries for services';
COMMENT ON COLUMN service_docs.doc_type IS 'Document type: readme, guide, reference, tutorial, changelog, api, architecture, runbook, or other';
COMMENT ON COLUMN service_docs.content IS 'Document content (typically Markdown)';
COMMENT ON COLUMN service_docs.content_format IS 'Content format: markdown, html, or plaintext';
COMMENT ON COLUMN service_docs.parent_id IS 'Parent document for hierarchical organization';
COMMENT ON COLUMN service_docs.sort_order IS 'Sort order within parent or service';
COMMENT ON COLUMN service_docs.external_url IS 'Link to external documentation source';
COMMENT ON COLUMN service_docs.published_at IS 'Timestamp when document was first published';
