'use client'

import { LayoutDashboard, Info, FileCode, Play, FileText } from "lucide-react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { JobDefinitionOverview } from './job-definition-sections/overview'
import { JobDefinitionDetails } from './job-definition-sections/details'
import { JobDefinitionBlueprintTools } from './job-definition-sections/blueprint-tools'
import { JobDefinitionJobRuns } from './job-definition-sections/job-runs'
import { JobDefinitionArtifacts } from './job-definition-sections/artifacts'

interface JobDefinition {
  id: string
  name: string
  enabledTools?: string[]
  promptContent?: string
  blueprint?: string
  sourceJobDefinitionId?: string
  sourceRequestId?: string
  lastStatus?: string
  lastInteraction?: string
  latestStatusUpdate?: string
}

interface JobDefinitionDetailLayoutProps {
  record: JobDefinition
}

export function JobDefinitionDetailLayout({ record }: JobDefinitionDetailLayoutProps) {
  return (
    <div className="h-full overflow-auto p-4">
      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="mb-2 border">
          <TabsTrigger value="overview" className="gap-2">
            <LayoutDashboard className="h-4 w-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="details" className="gap-2">
            <Info className="h-4 w-4" />
            Details
          </TabsTrigger>
          <TabsTrigger value="blueprint" className="gap-2">
            <FileCode className="h-4 w-4" />
            Blueprint & Tools
          </TabsTrigger>
          <TabsTrigger value="runs" className="gap-2">
            <Play className="h-4 w-4" />
            Job Runs
          </TabsTrigger>
          <TabsTrigger value="artifacts" className="gap-2">
            <FileText className="h-4 w-4" />
            Artifacts
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-0">
          <JobDefinitionOverview jobDefinition={record} />
        </TabsContent>
        <TabsContent value="details" className="mt-0">
          <JobDefinitionDetails jobDefinition={record} />
        </TabsContent>
        <TabsContent value="blueprint" className="mt-0">
          <JobDefinitionBlueprintTools jobDefinition={record} />
        </TabsContent>
        <TabsContent value="runs" className="mt-0">
          <JobDefinitionJobRuns jobDefinition={record} />
        </TabsContent>
        <TabsContent value="artifacts" className="mt-0">
          <JobDefinitionArtifacts jobDefinition={record} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
