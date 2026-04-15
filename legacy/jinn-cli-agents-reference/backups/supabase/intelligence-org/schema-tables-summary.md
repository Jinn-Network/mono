# Intelligence-Org Database Schema Summary

## Public Schema Tables

### Core Tables

#### `artifacts`
- **Purpose**: Stores job artifacts/outputs
- **Rows**: 58
- **Key Columns**:
  - `id` (uuid, PK)
  - `project_run_id` (uuid, FK → project_runs)
  - `content` (text)
  - `status` (text, default 'RAW')
  - `topic` (text, nullable)
  - `name` (text, nullable)
  - `job_id` (uuid, FK → job_board)
  - `parent_job_definition_id` (uuid, FK → jobs)
  - `source_event_id` (uuid, FK → events)
  - `project_definition_id` (uuid, FK → project_definitions)
  - Timestamps: `created_at`, `updated_at`

#### `events`
- **Purpose**: Event bus for system-wide event tracking
- **Rows**: 519
- **Key Columns**:
  - `id` (uuid, PK)
  - `event_type` (text)
  - `payload` (jsonb, default '{}')
  - `source_table` (text, nullable)
  - `source_id` (uuid, nullable)
  - `job_id` (uuid, nullable)
  - `project_run_id` (uuid, nullable)
  - `parent_event_id` (uuid, FK → events, self-referencing)
  - `correlation_id` (uuid)
  - `created_at` (timestamptz)

#### `job_board`
- **Purpose**: Job execution queue/registry
- **Rows**: 34
- **Key Columns**:
  - `id` (uuid, PK)
  - `status` (request_status enum, default 'PENDING')
  - `worker_id` (text, nullable)
  - `job_name` (text, nullable)
  - `input` (text, nullable)
  - `output` (text, nullable)
  - `inbox` (jsonb, default '[]')
  - `enabled_tools` (text array, nullable)
  - `model_settings` (jsonb, nullable)
  - `trigger_context` (jsonb, nullable)
  - `delegated_work_context` (jsonb, nullable)
  - `recent_runs_context` (jsonb, nullable)
  - `job_definition_id` (uuid, FK → jobs)
  - `parent_job_definition_id` (uuid, FK → jobs)
  - `project_definition_id` (uuid, FK → project_definitions)
  - `project_run_id` (uuid, FK → project_runs)
  - `project_name` (text, nullable)
  - `source_event_id` (uuid, FK → events)
  - `job_report_id` (uuid, FK → job_reports)
  - Timestamps: `created_at`, `updated_at`, `in_progress_at`

#### `job_reports`
- **Purpose**: Completed job execution reports
- **Rows**: 31
- **Key Columns**:
  - `id` (uuid, PK)
  - `job_id` (uuid, FK → job_board)
  - `worker_id` (text)
  - `status` (text, check: 'COMPLETED' or 'FAILED')
  - `duration_ms` (integer)
  - `total_tokens` (integer, default 0)
  - `request_text` (jsonb, nullable)
  - `response_text` (jsonb, nullable)
  - `final_output` (text, nullable)
  - `tools_called` (jsonb, default '[]')
  - `error_message` (text, nullable)
  - `error_type` (text, nullable)
  - `raw_telemetry` (jsonb, default '{}')
  - `parent_job_definition_id` (uuid, FK → jobs)
  - `project_definition_id` (uuid, FK → project_definitions)
  - `source_event_id` (uuid, FK → events)
  - `created_at` (timestamptz)

#### `jobs`
- **Purpose**: Job definitions/templates
- **Rows**: 28
- **Key Columns**:
  - `id` (uuid, PK)
  - `job_id` (uuid)
  - `version` (integer)
  - `name` (text)
  - `description` (text, nullable)
  - `prompt_content` (text)
  - `enabled_tools` (text array, default '{}')
  - `schedule_config` (jsonb)
  - `model_settings` (jsonb, default '{}')
  - `is_active` (boolean, default false)
  - `project_definition_id` (uuid, FK → project_definitions)
  - `project_run_id` (uuid, FK → project_runs)
  - `parent_job_definition_id` (uuid, FK → jobs, self-referencing)
  - Timestamps: `created_at`, `updated_at`

#### `memories`
- **Purpose**: Agent memory/knowledge storage with vector embeddings
- **Rows**: 2
- **Key Columns**:
  - `id` (uuid, PK)
  - `content` (text)
  - `embedding` (vector type)
  - `metadata` (jsonb, nullable)
  - `linked_memory_id` (uuid, FK → memories, self-referencing)
  - `link_type` (text, nullable)
  - `job_id` (uuid, FK → job_board)
  - `project_run_id` (uuid, FK → project_runs)
  - `parent_job_definition_id` (uuid, FK → jobs)
  - `source_event_id` (uuid, FK → events)
  - `project_definition_id` (uuid, FK → project_definitions)
  - Timestamps: `created_at`, `last_accessed_at`

#### `memories_history`
- **Purpose**: Historical memory records
- **Rows**: 14
- **Key Columns**:
  - `id` (uuid, PK)
  - `content` (text, nullable)
  - `embedding` (vector, nullable)
  - `metadata` (jsonb, nullable)
  - Timestamps: `created_at`, `last_accessed_at`, `deleted_at`

#### `messages`
- **Purpose**: Inter-agent/job messaging
- **Rows**: 42
- **Key Columns**:
  - `id` (uuid, PK)
  - `content` (text)
  - `status` (text, default 'PENDING')
  - `job_id` (uuid, FK → job_board)
  - `project_run_id` (uuid, FK → project_runs)
  - `parent_job_definition_id` (uuid, FK → jobs)
  - `source_event_id` (uuid, FK → events)
  - `project_definition_id` (uuid, FK → project_definitions)
  - `to_job_definition_id` (uuid, nullable)
  - `created_at` (timestamptz)

#### `project_definitions`
- **Purpose**: Project/workstream definitions
- **Rows**: 1
- **Key Columns**:
  - `id` (uuid, PK)
  - `name` (text)
  - `objective` (text, nullable)
  - `strategy` (text, nullable)
  - `kpis` (jsonb, default '{}')
  - `owner_job_definition_id` (uuid, FK → jobs)
  - `parent_project_definition_id` (uuid, FK → project_definitions, self-referencing)
  - Timestamps: `created_at`, `updated_at`

#### `project_runs`
- **Purpose**: Project execution instances/threads
- **Rows**: 446
- **Key Columns**:
  - `id` (uuid, PK)
  - `status` (text, default 'OPEN')
  - `summary` (jsonb, nullable)
  - `job_id` (uuid, FK → job_board)
  - `project_definition_id` (uuid, FK → project_definitions)
  - Timestamps: `created_at`, `updated_at`

#### `transaction_requests`
- **Purpose**: On-chain transaction queue for Gnosis Safe/EOA execution
- **Rows**: 0
- **Key Columns**:
  - `id` (uuid, PK)
  - `status` (transaction_status enum, default 'PENDING')
  - `execution_strategy` (execution_strategy enum, default 'SAFE')
  - `chain_id` (bigint)
  - `payload` (jsonb)
  - `payload_hash` (text, unique)
  - `idempotency_key` (text, nullable)
  - `safe_tx_hash` (text, nullable)
  - `tx_hash` (text, nullable)
  - `error_code` (transaction_error_code enum, nullable)
  - `error_message` (text, nullable)
  - `worker_id` (text, nullable)
  - `source_job_id` (uuid, FK → job_board)
  - `attempt_count` (integer, default 0)
  - Timestamps: `created_at`, `updated_at`, `claimed_at`, `completed_at`

### On-Chain Data Tables (Ponder Indexed)

#### `onchain_request_claims`
- **Purpose**: On-chain marketplace request claims
- **Rows**: 1831
- **Key Columns**:
  - `request_id` (text, PK)
  - `worker_address` (text)
  - `status` (text, check: 'IN_PROGRESS', 'COMPLETED', 'DELEGATING', 'WAITING', 'FAILED')
  - Timestamps: `claimed_at`, `completed_at`

#### `onchain_job_reports`
- **Purpose**: On-chain job completion reports
- **Rows**: 1810
- **Key Columns**:
  - `id` (uuid, PK)
  - `request_id` (text, unique)
  - `worker_address` (text)
  - `status` (text)
  - `duration_ms` (integer)
  - `total_tokens` (integer, default 0)
  - `tools_called` (jsonb, default '[]')
  - `final_output` (text, nullable)
  - `error_message` (text, nullable)
  - `error_type` (text, nullable)
  - `raw_telemetry` (jsonb, default '{}')
  - `created_at` (timestamptz)

#### `onchain_artifacts`
- **Purpose**: On-chain artifact records
- **Rows**: 3974
- **Key Columns**:
  - `id` (uuid, PK)
  - `request_id` (text)
  - `worker_address` (text)
  - `cid` (text)
  - `topic` (text)
  - `content` (text, nullable)
  - `created_at` (timestamptz)

#### `onchain_messages`
- **Purpose**: On-chain messaging records
- **Rows**: 4
- **Key Columns**:
  - `id` (uuid, PK)
  - `request_id` (text)
  - `worker_address` (text, nullable)
  - `content` (text)
  - `status` (text, default 'PENDING')
  - `created_at` (timestamptz)

#### `onchain_transaction_requests`
- **Purpose**: On-chain transaction request tracking
- **Rows**: 0
- **Key Columns**:
  - `id` (uuid, PK)
  - `request_id` (text, nullable)
  - `worker_address` (text, nullable)
  - `chain_id` (bigint)
  - `payload` (jsonb)
  - `payload_hash` (text, unique)
  - `execution_strategy` (text, check: 'EOA' or 'SAFE')
  - `status` (text, default 'PENDING')
  - `idempotency_key` (text, nullable, unique)
  - `safe_tx_hash` (text, nullable)
  - `tx_hash` (text, nullable)
  - `error_code` (text, nullable)
  - `error_message` (text, nullable)
  - Timestamps: `created_at`, `updated_at`

### System Tables

#### `system_state`
- **Purpose**: System-wide state management
- **Rows**: 0
- **Key Columns**:
  - `key` (text, PK)
  - `value` (jsonb, nullable)
  - `updated_at` (timestamptz, default now())

#### `system_state_history`
- **Purpose**: Historical system state changes
- **Rows**: 0
- **Key Columns**:
  - `id` (uuid, PK)
  - `state_key` (text)
  - `old_value` (text, nullable)
  - `rationale_for_change` (text, nullable)
  - `created_at` (timestamptz)

## Views

### `v_job_lineage`
- **Purpose**: Job execution lineage and relationships
- **Columns**: job_run_id, job_definition_id, job_name, source_event_id, project_run_id, job_status, event_type, event_project_run_id
- **Definition**: Joins job_board with job_reports and events to show job execution context

## Extensions Used

- `pg_graphql` (1.5.11) - GraphQL API
- `pg_cron` (1.6) - Job scheduler
- `vector` (0.8.0) - Vector embeddings for memories
- `uuid-ossp` (1.1) - UUID generation
- `pgcrypto` (1.3) - Cryptographic functions
- `pg_stat_statements` (1.11) - Query statistics
- `supabase_vault` (0.3.1) - Secrets management

## Key Relationships

### Job Hierarchy
- `jobs.parent_job_definition_id` → `jobs.id` (self-referencing)
- `job_board.parent_job_definition_id` → `jobs.id`
- `job_board.job_definition_id` → `jobs.id`

### Project Hierarchy
- `project_definitions.parent_project_definition_id` → `project_definitions.id` (self-referencing)
- `project_definitions.owner_job_definition_id` → `jobs.id`
- `project_runs.project_definition_id` → `project_definitions.id`

### Event Tracking
- Most tables link to `events.id` via `source_event_id`
- `events.parent_event_id` → `events.id` (self-referencing event chains)

### Artifact & Memory Context
- All core tables link to `project_run_id` and `project_definition_id`
- Artifacts, memories, and messages track their originating job

## Database Statistics
- Total public schema tables: 16 main tables + 5 on-chain tables
- Total rows across main tables: ~2,900+
- Total on-chain indexed rows: ~7,600+
- Auth/Storage schemas: Standard Supabase schemas (not backed up)















