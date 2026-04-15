'use client'

import { JobImpactReport, CreatedRecord } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { IdLink } from './id-link';
import { useState, useEffect } from 'react';

function DetailItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-gray-100 pb-3">
      <div className="font-medium text-gray-900 text-sm mb-1">{label}:</div>
      <div className="text-sm text-gray-400">{children}</div>
    </div>
  );
}

function CreatedRecords({ records }: { records: CreatedRecord[] }) {
  if (records.length === 0) {
    return <p className="text-sm text-gray-500">This job did not create any new records.</p>;
  }

  return (
    <ul className="space-y-2">
      {records.map(record => (
        <li key={record.id} className="flex items-center space-x-2 text-sm">
          <span className="font-semibold">{record.record_type}:</span>
          <IdLink collection={record.record_type} id={String(record.id)} />
          <span>({record.description})</span>
        </li>
      ))}
    </ul>
  );
}

interface CausalChain {
  source_artifact?: {
    id: string;
    topic: string;
    content: string;
    created_at: string;
  } | null;
  triggered_jobs?: Array<{
    id: string;
    job_name: string;
    status: string;
    created_at: string;
  }>;
  emitted_artifacts?: Array<{
    id: string;
    topic: string;
    content: string;
    created_at: string;
  }>;
}

function CausalChainView({ jobId }: { jobId: string }) {
  const [causalData, setCausalData] = useState<CausalChain | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchCausalChain = async () => {
      try {
        // We no longer use artifact-based causality; events are the source of truth
        setCausalData({
          source_artifact: null,
          triggered_jobs: [],
          emitted_artifacts: [],
        });

      } catch (err) {
        console.error('Error fetching causal chain:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    fetchCausalChain();
  }, [jobId]);

  if (loading) {
    return <div className="text-sm text-gray-500">Loading causal chain...</div>;
  }

  if (error) {
    return <div className="text-sm text-red-500">Error loading causal chain: {error}</div>;
  }

  if (!causalData) {
    return <div className="text-sm text-gray-500">No causal data available.</div>;
  }

  return (
    <div className="space-y-6">
      {/* Source Artifact */}
      {causalData.source_artifact && (
        <Card>
          <CardHeader>
            <CardTitle>Triggering Event</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <DetailItem label="Source Artifact">
                <IdLink collection="artifacts" id={causalData.source_artifact.id} />
                <span className="ml-2 text-sm text-gray-400">({causalData.source_artifact.topic})</span>
              </DetailItem>
              <DetailItem label="Created At">
                {new Date(causalData.source_artifact.created_at).toLocaleString()}
              </DetailItem>
              <DetailItem label="Content Preview">
                <div className="text-sm bg-muted p-2 rounded max-h-20 overflow-y-auto">
                  {typeof causalData.source_artifact.content === 'string' 
                    ? causalData.source_artifact.content.substring(0, 200) + 
                      (causalData.source_artifact.content.length > 200 ? '...' : '')
                    : JSON.stringify(causalData.source_artifact.content).substring(0, 200) + '...'
                  }
                </div>
              </DetailItem>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Emitted Artifacts */}
      {causalData.emitted_artifacts && causalData.emitted_artifacts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Artifacts Created by This Job</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {causalData.emitted_artifacts.map((artifact) => (
                <div key={artifact.id} className="border rounded-lg p-3 bg-muted">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <IdLink collection="artifacts" id={artifact.id} />
                      <span className="text-sm font-medium text-gray-400">{artifact.topic}</span>
                    </div>
                    <span className="text-xs text-gray-500">
                      {new Date(artifact.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="text-sm text-gray-400 bg-card p-2 rounded max-h-16 overflow-y-auto">
                    {typeof artifact.content === 'string' 
                      ? artifact.content.substring(0, 150) + (artifact.content.length > 150 ? '...' : '')
                      : JSON.stringify(artifact.content).substring(0, 150) + '...'
                    }
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Downstream Jobs */}
      {causalData.triggered_jobs && causalData.triggered_jobs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Downstream Jobs Triggered</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {causalData.triggered_jobs.map((job) => (
                <div key={job.id} className="border rounded-lg p-3 bg-muted">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <IdLink collection="job_board" id={job.id} />
                      <span className="font-medium">{job.job_name}</span>
                      <Badge 
                        variant={
                          job.status === 'COMPLETED' ? 'default' :
                          job.status === 'FAILED' ? 'destructive' :
                          'secondary'
                        }
                      >
                        {job.status}
                      </Badge>
                    </div>
                    <span className="text-xs text-gray-500">
                      {new Date(job.created_at).toLocaleString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function JobImpactView({ report }: { report: JobImpactReport }) {
  const { job_report, source_schedule, created_records } = report;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Execution Summary</CardTitle>
        </CardHeader>
        <CardContent>
          {job_report ? (
            <div className="space-y-2">
              <DetailItem label="Status">{job_report.status}</DetailItem>
              <DetailItem label="Duration">{job_report.duration_ms}ms</DetailItem>
              <DetailItem label="Total Tokens">{job_report.total_tokens}</DetailItem>
              <DetailItem label="Final Output">{job_report.final_output}</DetailItem>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No job report found.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Legacy Causality</CardTitle>
        </CardHeader>
        <CardContent>
          {source_schedule ? (
            <DetailItem label="Triggered By Schedule">
              <IdLink collection="job_schedules" id={String(source_schedule.id)} />
              <span>({source_schedule.job_name})</span>
            </DetailItem>
          ) : (
            <p className="text-sm text-gray-500">Source schedule not found.</p>
          )}
        </CardContent>
      </Card>

      {/* Enhanced Causal Chain View */}
      {job_report?.job_id && (
        <CausalChainView jobId={String(job_report.job_id)} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Impact: Created Records</CardTitle>
        </CardHeader>
        <CardContent>
          <CreatedRecords records={created_records} />
        </CardContent>
      </Card>
    </div>
  );
}