'use client'

import { useEffect, useState } from 'react'
import { getRequest, getWorkstreamArtifact, fetchIpfsContent, type Artifact } from '@/lib/subgraph'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { ArtifactDetailView } from '@/components/artifact-detail-view'
import { JobGraphView } from '@/components/graph/job-graph-view'
import { WorkstreamTreeList } from '@/components/workstream-tree-list'
import { SiteHeader } from '@/components/site-header'
import { WorkstreamJobDefinitionsList, WorkstreamJobRunsList } from '@/components/workstream-job-lists'
import { Network, GitBranch, Play, FileCode, FileText, Heart, Files } from 'lucide-react'
import { WorkstreamHealth } from '@/components/workstream-health'
import { ArtifactsGallery } from '@/components/ventures/artifacts-gallery'

interface WorkstreamPageProps {
  params: Promise<{ id: string }>
}

interface RootRequest {
  jobName?: string
}

export default function WorkstreamPage({ params }: WorkstreamPageProps) {
  const [workstreamId, setWorkstreamId] = useState<string>('')
  const [rootRequest, setRootRequest] = useState<RootRequest | null>(null)
  const [briefingWithContent, setBriefingWithContent] = useState<(Artifact & { content?: string }) | null>(null)
  const [loading, setLoading] = useState(true)
  const [definitionsCount, setDefinitionsCount] = useState<number>(0)
  const [runsCount, setRunsCount] = useState<number>(0)

  useEffect(() => {
    async function loadData() {
      const resolvedParams = await params
      const id = decodeURIComponent(resolvedParams.id)
      setWorkstreamId(id)

      try {
        const request = await getRequest(id)
        if (!request) {
          setLoading(false)
          return
        }
        setRootRequest(request)

        const briefing = await getWorkstreamArtifact(id, 'launcher_briefing')
        
        if (briefing?.cid) {
          const ipfsContent = await fetchIpfsContent(briefing.cid)
          if (ipfsContent) {
            setBriefingWithContent({
              ...briefing,
              content: ipfsContent.content
            })
          } else {
            setBriefingWithContent(briefing)
          }
        } else if (briefing) {
          setBriefingWithContent(briefing)
        }
      } catch (error) {
        console.error('Failed to load workstream data:', error)
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [params])

  // Update document title when workstream data is loaded
  useEffect(() => {
    const truncate = (text: string, maxLength: number = 10) => 
      text.length <= maxLength ? text : text.substring(0, maxLength) + '…'
    
    if (rootRequest?.jobName) {
      document.title = `${truncate(rootRequest.jobName)} | Workstream | Jinn Explorer`
    } else if (rootRequest) {
      document.title = 'Unnamed… | Workstream | Jinn Explorer'
    }
  }, [rootRequest])

  if (loading) {
    const loadingBreadcrumbs = [
      { label: 'Workstreams', href: '/workstreams' },
      { label: 'Loading...' }
    ]

    return (
      <>
        <SiteHeader breadcrumbs={loadingBreadcrumbs} />
        <div className="p-4 md:p-6">
          <p>Loading workstream...</p>
        </div>
      </>
    )
  }

  if (!rootRequest) {
    const notFoundBreadcrumbs = [
      { label: 'Workstreams', href: '/workstreams' },
      { label: 'Not Found' }
    ]

    return (
      <>
        <SiteHeader breadcrumbs={notFoundBreadcrumbs} />
        <div className="p-4 md:p-6">
          <p>Workstream not found</p>
        </div>
      </>
    )
  }

  const workstreamTitle = rootRequest.jobName || 'Unnamed Workstream'
  const breadcrumbs = [
    { label: 'Workstreams', href: '/workstreams' },
    { label: workstreamTitle }
  ]

  return (
    <>
      <SiteHeader breadcrumbs={breadcrumbs} />
      <div className="p-4 md:p-6">
        <Tabs defaultValue="tree" className="w-full">
          <TabsList className="mb-4 border w-full md:w-auto">
            <TabsTrigger value="tree" className="gap-1 md:gap-2">
              <GitBranch className="h-4 w-4 hidden sm:block" />
              Tree
            </TabsTrigger>
            <TabsTrigger value="graph" className="gap-1 md:gap-2">
              <Network className="h-4 w-4 hidden sm:block" />
              Graph
            </TabsTrigger>
            {briefingWithContent && (
              <TabsTrigger value="briefing" className="gap-1 md:gap-2">
                <FileText className="h-4 w-4 hidden sm:block" />
                Briefing
              </TabsTrigger>
            )}
            <TabsTrigger value="definitions" className="gap-1 md:gap-2">
              <FileCode className="h-4 w-4 hidden sm:block" />
              <span className="hidden sm:inline">Job </span>Defs{definitionsCount > 0 && <span className="hidden sm:inline"> ({definitionsCount})</span>}
            </TabsTrigger>
            <TabsTrigger value="runs" className="gap-1 md:gap-2">
              <Play className="h-4 w-4 hidden sm:block" />
              Runs{runsCount > 0 && <span className="hidden sm:inline"> ({runsCount})</span>}
            </TabsTrigger>
            <TabsTrigger value="health" className="gap-1 md:gap-2">
              <Heart className="h-4 w-4 hidden sm:block" />
              Health
            </TabsTrigger>
            <TabsTrigger value="artifacts" className="gap-1 md:gap-2">
              <Files className="h-4 w-4 hidden sm:block" />
              Artifacts
            </TabsTrigger>
          </TabsList>

          <TabsContent value="tree" className="mt-0">
            <Card className="py-0 gap-0">
              <CardContent className="p-0">
                <WorkstreamTreeList rootId={workstreamId} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="graph" className="mt-0">
            <Card>
              <CardContent className="p-0 border-t">
                <div className="h-[600px] overflow-hidden">
                  <JobGraphView rootId={workstreamId} groupByDefinition={true} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {briefingWithContent && (
            <TabsContent value="briefing" className="mt-0">
              <Card>
                <CardContent className="pt-6">
                  <ArtifactDetailView record={briefingWithContent} />
                </CardContent>
              </Card>
            </TabsContent>
          )}

          <TabsContent value="definitions" className="mt-0">
            <WorkstreamJobDefinitionsList 
              workstreamId={workstreamId} 
              onCountUpdate={setDefinitionsCount}
            />
          </TabsContent>

          <TabsContent value="runs" className="mt-0">
            <WorkstreamJobRunsList
              workstreamId={workstreamId}
              onCountUpdate={setRunsCount}
            />
          </TabsContent>

          <TabsContent value="health" className="mt-0">
            <WorkstreamHealth workstreamId={workstreamId} />
          </TabsContent>

          <TabsContent value="artifacts" className="mt-0">
            <div className="min-h-[500px]">
              <ArtifactsGallery workstreamId={workstreamId} />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}
