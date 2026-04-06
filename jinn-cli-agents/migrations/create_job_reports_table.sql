-- Migration: Create job_reports table for telemetry and debugging
-- Purpose: Store comprehensive execution reports for each job run

CREATE TABLE job_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES job_board(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Execution Summary
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'FAILED')),
  duration_ms INTEGER NOT NULL,
  total_tokens INTEGER DEFAULT 0,
  
  -- Complete Request/Response Cycle
  request_text JSONB,           -- Full conversation sent to Gemini API
  response_text JSONB,          -- Complete API response with all rounds
  final_output TEXT,            -- Clean final answer returned to job_board
  
  -- Tool Usage Details
  tools_called JSONB DEFAULT '[]'::jsonb,  -- Array of tool calls with timing/success
  
  -- Error Information
  error_message TEXT,
  error_type TEXT,              -- API_ERROR, TOOL_ERROR, TIMEOUT, SYSTEM_ERROR
  
  -- Raw Telemetry Data
  raw_telemetry JSONB DEFAULT '{}'::jsonb
);

-- Indexes for common query patterns
CREATE INDEX idx_job_reports_job_id ON job_reports(job_id);
CREATE INDEX idx_job_reports_created_at ON job_reports(created_at DESC);
CREATE INDEX idx_job_reports_status ON job_reports(status);
CREATE INDEX idx_job_reports_worker_id ON job_reports(worker_id);
CREATE INDEX idx_job_reports_duration ON job_reports(duration_ms);

-- Index for finding failed jobs with specific error types
CREATE INDEX idx_job_reports_error_type ON job_reports(error_type) WHERE status = 'FAILED';

-- Comments for documentation
COMMENT ON TABLE job_reports IS 'Comprehensive execution reports for job debugging and analytics';
COMMENT ON COLUMN job_reports.request_text IS 'Complete conversation sent to Gemini API including context and tool responses';
COMMENT ON COLUMN job_reports.response_text IS 'Full API response including all tool calls and model responses';
COMMENT ON COLUMN job_reports.tools_called IS 'Array of tool calls with execution details: [{"tool": "read_records", "duration_ms": 1687, "success": true, "args": {...}}]';
COMMENT ON COLUMN job_reports.raw_telemetry IS 'Additional telemetry data: session_id, token breakdown, system context, etc.';