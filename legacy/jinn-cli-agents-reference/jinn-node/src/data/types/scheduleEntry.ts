/**
 * Schedule entry for venture dispatch scheduling.
 *
 * Each entry defines a cron-triggered template dispatch.
 * The venture watcher evaluates these entries and dispatches
 * finite workstreams when cron ticks are due.
 */
export interface ScheduleEntry {
  /** Unique entry ID (UUID) */
  id: string;

  /** UUID from Supabase `templates` table */
  templateId: string;

  /** Cron expression, e.g. "0 6 * * 1" (weekly Monday 6am UTC) */
  cron: string;

  /** Static input data merged with template's input_schema defaults */
  input?: Record<string, any>;

  /** Human-readable label, e.g. "Weekly content", "Daily measurement" */
  label?: string;

  /** Whether this schedule entry is active. Defaults to true. */
  enabled?: boolean;
}
