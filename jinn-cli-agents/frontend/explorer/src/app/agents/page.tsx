import { Metadata } from 'next'
import { SiteHeader } from '@/components/site-header'
import { AgentsCatalog } from '@/components/agents-catalog'

export const metadata: Metadata = {
  title: 'Agents',
  description: 'Browse active agents with execution history and metrics',
}

export default function AgentsPage() {
  const breadcrumbs = [
    { label: 'Agents' }
  ]

  return (
    <>
      <SiteHeader breadcrumbs={breadcrumbs} />
      <div className="p-4 md:p-6">
        <AgentsCatalog />
      </div>
    </>
  )
}

