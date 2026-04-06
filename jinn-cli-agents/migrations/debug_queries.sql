-- Job Reporting System - Debug Queries
-- Use these queries to analyze job execution and debug issues

-- 1. Recent job performance overview (with bidirectional linking)
SELECT 
  jr.job_id,
  jr.id as report_id,
  jr.status,
  jr.duration_ms,
  jr.total_tokens,
  jsonb_array_length(jr.tools_called) as tool_count,
  jr.error_type,
  jr.created_at,
  jb.job_report_id as linked_report_id
FROM job_reports jr
LEFT JOIN job_board jb ON jr.job_id = jb.id
ORDER BY jr.created_at DESC 
LIMIT 20;

-- 2. Job success rate by time period
SELECT 
  DATE_TRUNC('hour', created_at) as hour,
  COUNT(*) as total_jobs,
  COUNT(*) FILTER (WHERE status = 'COMPLETED') as successful,
  COUNT(*) FILTER (WHERE status = 'FAILED') as failed,
  ROUND(COUNT(*) FILTER (WHERE status = 'COMPLETED') * 100.0 / COUNT(*), 2) as success_rate
FROM job_reports 
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY DATE_TRUNC('hour', created_at)
ORDER BY hour DESC;

-- 3. Average performance metrics
SELECT 
  status,
  COUNT(*) as job_count,
  AVG(duration_ms) as avg_duration_ms,
  AVG(total_tokens) as avg_tokens,
  AVG(jsonb_array_length(tools_called)) as avg_tool_calls
FROM job_reports 
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY status;

-- 4. Debug specific failed job
SELECT 
  jr.job_id,
  jr.error_message,
  jr.error_type,
  jr.tools_called,
  jr.final_output,
  jb.input_prompt
FROM job_reports jr
JOIN job_board jb ON jr.job_id = jb.id
WHERE jr.status = 'FAILED'
ORDER BY jr.created_at DESC 
LIMIT 5;

-- 5. Tool usage analysis
SELECT 
  tool_data->>'tool' as tool_name,
  COUNT(*) as usage_count,
  AVG((tool_data->>'duration_ms')::float) as avg_duration_ms,
  COUNT(*) FILTER (WHERE (tool_data->>'success')::boolean = true) as success_count,
  COUNT(*) FILTER (WHERE (tool_data->>'success')::boolean = false) as failure_count
FROM job_reports jr,
     jsonb_array_elements(jr.tools_called) as tool_data
WHERE jr.created_at > NOW() - INTERVAL '24 hours'
GROUP BY tool_data->>'tool'
ORDER BY usage_count DESC;

-- 6. Worker performance comparison
SELECT 
  worker_id,
  COUNT(*) as jobs_processed,
  AVG(duration_ms) as avg_duration,
  COUNT(*) FILTER (WHERE status = 'COMPLETED') as successful,
  ROUND(COUNT(*) FILTER (WHERE status = 'COMPLETED') * 100.0 / COUNT(*), 2) as success_rate
FROM job_reports 
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY worker_id
ORDER BY jobs_processed DESC;

-- 7. Token usage trends
SELECT 
  DATE_TRUNC('hour', created_at) as hour,
  AVG(total_tokens) as avg_tokens,
  MIN(total_tokens) as min_tokens,
  MAX(total_tokens) as max_tokens,
  SUM(total_tokens) as total_tokens_used
FROM job_reports 
WHERE created_at > NOW() - INTERVAL '24 hours'
  AND status = 'COMPLETED'
GROUP BY DATE_TRUNC('hour', created_at)
ORDER BY hour DESC;

-- 8. Error pattern analysis
SELECT 
  error_type,
  COUNT(*) as error_count,
  ARRAY_AGG(DISTINCT SUBSTRING(error_message, 1, 100)) as sample_messages,
  AVG(duration_ms) as avg_duration_before_failure
FROM job_reports 
WHERE status = 'FAILED'
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY error_type
ORDER BY error_count DESC;

-- 9. Complete job execution trace (for debugging specific job)
-- Replace 'YOUR_JOB_ID' with actual job ID
/*
SELECT 
  jr.job_id,
  jr.status,
  jr.duration_ms,
  jr.total_tokens,
  jr.request_text,
  jr.response_text,
  jr.tools_called,
  jr.error_message,
  jr.raw_telemetry,
  jb.input_prompt,
  jb.input_context
FROM job_reports jr
JOIN job_board jb ON jr.job_id = jb.id
WHERE jr.job_id = 'YOUR_JOB_ID';
*/

-- 10. Most recent job with full details (for quick debugging)
SELECT 
  jr.job_id,
  jr.status,
  jr.duration_ms,
  jr.total_tokens,
  jr.tools_called,
  jr.error_message,
  SUBSTRING(jr.final_output, 1, 200) as output_preview,
  SUBSTRING(jb.input_prompt, 1, 200) as prompt_preview
FROM job_reports jr
JOIN job_board jb ON jr.job_id = jb.id
ORDER BY jr.created_at DESC 
LIMIT 1;

-- 11. Check bidirectional linking integrity
SELECT 
  'Missing report links' as issue_type,
  COUNT(*) as count
FROM job_board jb
LEFT JOIN job_reports jr ON jb.job_report_id = jr.id
WHERE jb.status IN ('COMPLETED', 'FAILED') 
  AND jb.job_report_id IS NULL
  AND jb.updated_at > NOW() - INTERVAL '24 hours'

UNION ALL

SELECT 
  'Mismatched report links' as issue_type,
  COUNT(*) as count
FROM job_board jb
JOIN job_reports jr ON jb.job_report_id = jr.id
WHERE jr.job_id != jb.id

UNION ALL

SELECT 
  'Orphaned reports' as issue_type,
  COUNT(*) as count
FROM job_reports jr
LEFT JOIN job_board jb ON jr.job_id = jb.id
WHERE jb.id IS NULL;