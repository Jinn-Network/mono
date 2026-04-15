import { z } from 'zod';

// Common table names used across multiple tools (hardcoded allowlist)
export const tableNames = [
  'artifacts',
  'events',
  'job_board',
  'job_reports',
  'jobs',
  'memories',
  'messages',
  // On-chain parallel tables
  'onchain_request_claims',
  'onchain_job_reports',
  'onchain_artifacts',
  'onchain_messages',
] as const;

export const tableNameSchema = z.enum(tableNames).describe('The name of the table to operate on');

// Memory-related types
export const linkTypeSchema = z.enum(['CAUSE', 'EFFECT', 'ELABORATION', 'CONTRADICTION', 'SUPPORT']);

export interface Memory {
  id: string;
  content: string;
  embedding: string;
  created_at: string;
  last_accessed_at?: string;
  metadata?: Record<string, any>;
  linked_memory_id?: string;
  link_type?: z.infer<typeof linkTypeSchema>;
  linked_memory?: Memory; // For populated linked memories
}

export type LinkType = z.infer<typeof linkTypeSchema>;

// Type for linked memories query result (partial memory data)
export interface LinkedMemory {
  id: string;
  content: string;
  metadata?: Record<string, any>;
}

// Tool parameter schemas
export const traceThreadParams = z.object({
  thread_id: z.string().uuid().describe('The ID of the thread to trace')
});

export const reconstructJobParams = z.object({
  job_id: z.string().uuid().describe('The ID of the job to reconstruct')
});

export type TraceThreadParams = z.infer<typeof traceThreadParams>;

export type ReconstructJobParams = z.infer<typeof reconstructJobParams>;

// Search events types
export const searchEventsParams = z.object({
  event_type: z.enum(['ARTIFACT_CREATED', 'JOB_CREATED', 'THREAD_CREATED']).optional().describe('Filter by specific event type.'),
  status: z.string().optional().describe('Filter by status (e.g., COMPLETED, PENDING).'),
  job_name: z.string().optional().describe('Filter by job name pattern.'),
  topic: z.string().optional().describe('Filter by artifact topic pattern.'),
  thread_id: z.string().uuid().optional().describe('Filter by specific thread ID.'),
  time_range_hours: z.number().int().min(1).optional().describe('Limit results to events within the last X hours.'),
  cursor: z.string().optional().describe('Opaque cursor for fetching the next page of results.'),
});
export type SearchEventsParams = z.infer<typeof searchEventsParams>;

// Job-related types for the unified jobs table
export interface ScheduleFilters {
  [key: string]: string | number | boolean | string[];
}

export interface Job {
  id: string; // UUID of this specific version
  job_id: string; // Shared UUID across all versions
  version: number;
  name: string;
  description?: string;
  prompt_content: string;
  enabled_tools: string[];
  schedule_config: any; // Simplified internal format
  is_active: boolean;
  created_at: string; // ISO 8601 Date
  updated_at: string; // ISO 8601 Date
}

// Zod schemas for job creation
export const CreateJobInputSchema = z.object({
  name: z.string().describe('The name of the job'),
  description: z.string().optional().describe('Optional description of the job purpose'),
  prompt_content: z.string().describe('The full prompt content for this job'),
  enabled_tools: z.array(z.string()).describe('Array of tool names this job can use. Tools are validated dynamically against the server\'s registered tool registry; unknown tools will be rejected with an allowed tool list.'),
  project_definition_id: z.string().uuid().optional().describe('Optional. Link this job definition to a project definition.'),
  source_job_definition_id: z.string().uuid().optional().describe('Optional. Link this job to a source job for lineage tracking.'),
  // Simplified scheduling interface
  schedule_on: z.string().optional().describe(
    `Optional. If omitted, defaults to running the new job after the current job completes (alias: "after_this_job").

Set to "manual" or an event type to subscribe to. Supported alias: "after_this_job" => equivalent to "job.completed" bound to the current job.

Manual jobs are automatically dispatched once when created, then require manual re-enqueueing for future runs. Manual jobs inherit the project context from the current job execution and will fail if created outside of a job context.

Common event types:
- Job lifecycle: "job.created", "job.claimed", "job.completed", "job.failed"
- Project: "project_definition.created", "project_run.created", "project_run.updated", "project_run.completed"
- Data: "artifact.created", "artifact.updated", "memory.created", "memory.accessed", "message.created", "message.updated"
- System: "system.quiescent", "system_state.updated", "job_report.created"`
  ),
  // Allow nested filter objects (e.g., { payload: { job_definition_id: "..." } })
  filter: z.record(z.any()).optional().describe(
    `Optional flat filters to refine event routing.
Examples:
- For artifacts: { "topic": "analysis" }
- For job completion: { "job_name": "chief_orchestrator" }
Keys are simple strings; values are simple strings. These are merged into filters along with { event_type: schedule_on } when schedule_on != "manual".

Defaults and auto-binding:
- If schedule_on is omitted, the tool will schedule the job to run after this job completes by setting schedule_on = "job.completed" and filter.job_id = <current job id>.
- If schedule_on = "job.completed" and filter.job_id is not provided, the tool will auto-fill filter.job_id from the current job context when available. If no current job id is available, it will fall back to manual.`
  ),
  existing_job_id: z.string().uuid().optional().describe('UUID of existing job to create new version for'),
});

export type CreateJobInput = z.infer<typeof CreateJobInputSchema>; 
