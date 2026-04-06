'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardAction } from '@/components/ui/card'
import { TruncatedId } from '@/components/truncated-id'
import { useSubgraphCollection } from '@/hooks/use-subgraph-collection'
import { getWorkstreams, Workstream } from '@/lib/subgraph'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { ArrowRight, Rocket, Layers } from 'lucide-react'

// Types for Supabase data
interface Venture {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: 'active' | 'paused' | 'archived';
  root_workstream_id: string | null;
  token_address: string | null;
  token_symbol: string | null;
}

interface Service {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  venture_id: string;
}

// Client-side Supabase fetch helper
async function fetchFromSupabase<T>(table: string, params: Record<string, string> = {}): Promise<T[]> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('Supabase not configured');
    return [];
  }

  const searchParams = new URLSearchParams(params);
  const url = `${supabaseUrl}/rest/v1/${table}?${searchParams}`;

  try {
    const response = await fetch(url, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`Supabase query failed: ${response.status}`);
      return [];
    }

    return response.json();
  } catch (error) {
    console.error('Supabase fetch error:', error);
    return [];
  }
}

function VentureStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-500/10 text-green-500 border-green-500/20',
    paused: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    archived: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  };
  return (
    <Badge variant="outline" className={`text-xs ${colors[status] || colors.archived}`}>
      {status}
    </Badge>
  );
}

export function DashboardView() {
  const [workstreams, setWorkstreams] = useState<Workstream[]>([])
  const [workstreamsLoading, setWorkstreamsLoading] = useState(true)
  const [ventures, setVentures] = useState<Venture[]>([])
  const [venturesLoading, setVenturesLoading] = useState(true)
  const [services, setServices] = useState<Service[]>([])
  const [servicesLoading, setServicesLoading] = useState(true)

  // Fetch job runs (unified requests view)
  const { records: jobRuns, loading: jobRunsLoading } = useSubgraphCollection({
    collectionName: 'requests',
    pageSize: 5,
    enablePolling: true
  })

  const { records: artifacts, loading: artifactsLoading } = useSubgraphCollection({
    collectionName: 'artifacts',
    pageSize: 5,
    enablePolling: true
  })

  const { records: jobDefinitions, loading: jobDefinitionsLoading } = useSubgraphCollection({
    collectionName: 'jobDefinitions',
    pageSize: 5,
    enablePolling: true
  })

  // Fetch workstreams
  useEffect(() => {
    const fetchWorkstreams = async () => {
      setWorkstreamsLoading(true)
      try {
        const { requests } = await getWorkstreams({ limit: 5 })
        setWorkstreams(requests.items)
      } catch (error) {
        console.error('Error fetching workstreams:', error)
      } finally {
        setWorkstreamsLoading(false)
      }
    }
    fetchWorkstreams()
  }, [])

  // Fetch ventures from Supabase
  useEffect(() => {
    const fetchVentures = async () => {
      setVenturesLoading(true)
      try {
        const data = await fetchFromSupabase<Venture>('ventures', {
          select: 'id,name,slug,description,status,root_workstream_id,token_address,token_symbol',
          token_address: 'not.is.null',
          status: 'eq.active',
          order: 'created_at.desc',
          limit: '5',
        })
        setVentures(data)
      } catch (error) {
        console.error('Error fetching ventures:', error)
      } finally {
        setVenturesLoading(false)
      }
    }
    fetchVentures()
  }, [])

  // Fetch services from Supabase
  useEffect(() => {
    const fetchServices = async () => {
      setServicesLoading(true)
      try {
        const data = await fetchFromSupabase<Service>('services', {
          select: 'id,name,slug,description,venture_id',
          order: 'created_at.desc',
          limit: '5',
        })
        setServices(data)
      } catch (error) {
        console.error('Error fetching services:', error)
      } finally {
        setServicesLoading(false)
      }
    }
    fetchServices()
  }, [])

  const formatTimestamp = (timestamp: string | bigint) => {
    const ts = typeof timestamp === 'bigint' ? Number(timestamp) : Number(timestamp)
    const date = new Date(ts * 1000)
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  // Map job run delivery state to status
  const getJobRunStatus = (delivered?: boolean) => {
    return delivered ? 'COMPLETED' : 'PENDING'
  }

  return (
    <div className="p-4 md:p-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

        {/* Ventures Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Rocket className="h-5 w-5" />
              Ventures
            </CardTitle>
            <CardDescription>Autonomous projects with defined success criteria</CardDescription>
            <CardAction>
              <Link href="/ventures" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
                View All <ArrowRight className="h-3 w-3" />
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent>
            {venturesLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : ventures.length === 0 ? (
              <div className="text-sm text-muted-foreground">No ventures yet</div>
            ) : (
              <div className="space-y-3">
                {ventures.map((venture) => {
                  const href = venture.root_workstream_id
                    ? `/ventures/${venture.root_workstream_id}`
                    : `/ventures/${venture.id}`;
                  return (
                    <Link
                      key={venture.id}
                      href={href}
                      className="block p-3 rounded-md border hover:bg-accent transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <div className="font-medium text-sm truncate flex items-center gap-1.5">
                          {venture.name}
                          {venture.token_symbol && (
                            <Badge variant="outline" className="text-[10px] font-mono bg-primary/5 border-primary/20 text-primary">
                              ${venture.token_symbol}
                            </Badge>
                          )}
                        </div>
                        <VentureStatusBadge status={venture.status} />
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {venture.description || venture.slug}
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Services Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5" />
              Services
            </CardTitle>
            <CardDescription>Registered services with deployments and interfaces</CardDescription>
            <CardAction>
              <Link href="/services" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
                View All <ArrowRight className="h-3 w-3" />
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent>
            {servicesLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : services.length === 0 ? (
              <div className="text-sm text-muted-foreground">No services yet</div>
            ) : (
              <div className="space-y-3">
                {services.map((service) => (
                  <Link
                    key={service.id}
                    href={`/services/${service.id}`}
                    className="block p-3 rounded-md border hover:bg-accent transition-colors"
                  >
                    <div className="font-medium text-sm truncate">{service.name}</div>
                    <div className="text-xs text-muted-foreground truncate mt-1">
                      {service.description || service.slug}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Workstreams Card */}
        <Card>
          <CardHeader>
            <CardTitle>Workstreams</CardTitle>
            <CardDescription>Complex tasks broken down into coordinated AI agent workflows</CardDescription>
            <CardAction>
              <Link href="/workstreams" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
                View All <ArrowRight className="h-3 w-3" />
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent>
            {workstreamsLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : workstreams.length === 0 ? (
              <div className="text-sm text-muted-foreground">No workstreams yet</div>
            ) : (
              <div className="space-y-3">
                {workstreams.map((ws) => (
                  <Link
                    key={ws.id}
                    href={`/workstreams/${ws.id}`}
                    className="block p-3 rounded-md border hover:bg-accent transition-colors"
                  >
                    <div className="font-medium text-sm truncate">{ws.jobName || 'Unnamed'}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {formatTimestamp(ws.blockTimestamp)}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Job Definitions Card */}
        <Card>
          <CardHeader>
            <CardTitle>Job Definitions</CardTitle>
            <CardDescription>Templates that define what AI agents can do and how they work</CardDescription>
            <CardAction>
              <Link href="/jobDefinitions" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
                View All <ArrowRight className="h-3 w-3" />
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent>
            {jobDefinitionsLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : jobDefinitions.length === 0 ? (
              <div className="text-sm text-muted-foreground">No job definitions yet</div>
            ) : (
              <div className="space-y-3">
                {jobDefinitions.slice(0, 5).map((job: any) => (
                  <Link
                    key={job.id}
                    href={`/jobDefinitions/${job.id}`}
                    className="block p-3 rounded-md border hover:bg-accent transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="font-medium text-sm truncate">{job.name || 'Unnamed Job'}</div>
                      {job.lastStatus && <StatusBadge status={job.lastStatus} />}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <TruncatedId value={job.id} />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Job Runs Card (unified requests/deliveries) */}
        <Card>
          <CardHeader>
            <CardTitle>Job Runs</CardTitle>
            <CardDescription>Individual AI agent executions and their results</CardDescription>
            <CardAction>
              <Link href="/requests" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
                View All <ArrowRight className="h-3 w-3" />
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent>
            {jobRunsLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : jobRuns.length === 0 ? (
              <div className="text-sm text-muted-foreground">No job runs yet</div>
            ) : (
              <div className="space-y-3">
                {jobRuns.slice(0, 5).map((run: any) => (
                  <Link
                    key={run.id}
                    href={`/requests/${run.id}`}
                    className="block p-3 rounded-md border hover:bg-accent transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="font-medium text-sm truncate">{run.jobName || 'Unnamed Job'}</div>
                      <StatusBadge status={getJobRunStatus(run.delivered)} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatTimestamp(run.blockTimestamp)}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Artifacts Card */}
        <Card>
          <CardHeader>
            <CardTitle>Artifacts</CardTitle>
            <CardDescription>Content, reports, and outputs produced by AI agents</CardDescription>
            <CardAction>
              <Link href="/artifacts" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
                View All <ArrowRight className="h-3 w-3" />
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent>
            {artifactsLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : artifacts.length === 0 ? (
              <div className="text-sm text-muted-foreground">No artifacts yet</div>
            ) : (
              <div className="space-y-3">
                {artifacts.slice(0, 5).map((artifact: any) => (
                  <Link
                    key={artifact.id}
                    href={`/artifacts/${artifact.id}`}
                    className="block p-3 rounded-md border hover:bg-accent transition-colors"
                  >
                    <div className="font-medium text-sm truncate">{artifact.name}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {artifact.topic}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  )
}
