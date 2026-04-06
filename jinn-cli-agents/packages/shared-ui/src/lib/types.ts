// Generic type for any record from the database
export type DbRecord = {
  id: string | number;
  created_at?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

// List of all explorable table names
export const collectionNames = [
  'jobDefinitions',
  'requests',
  'deliveries',
  'artifacts',
  'messages',
  'templates',
  'workstreams',
] as const;

export type CollectionName = typeof collectionNames[number];

// Props for the main collection page (index view)
export interface CollectionPageProps {
  params: Promise<{
    collection: CollectionName;
  }>;
}

// Props for the record detail page (show view)
export interface RecordPageProps {
  params: Promise<{
    collection: CollectionName;
    id: string;
  }>;
}

// Timeline event types
export interface TimelineEvent {
  id: string;
  event_type: 'ARTIFACT_CREATED' | 'JOB_CREATED' | 'THREAD_CREATED';
  created_at: string;
  event_details: {
    id: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
}

// Job impact report types
export interface CreatedRecord {
  record_type: string;
  id: string;
  description: string;
}

export interface JobImpactReport {
  job_report: DbRecord | null;
  source_schedule: DbRecord | null;
  created_records: CreatedRecord[];
}
