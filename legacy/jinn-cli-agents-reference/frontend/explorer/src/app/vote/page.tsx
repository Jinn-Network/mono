import { Metadata } from 'next'
import { SiteHeader } from '@/components/site-header'
import { VotePageContent } from '@/components/vote/vote-page-content'

export const metadata: Metadata = {
  title: 'Vote for Jinn',
  description: 'Vote for the Jinn v2 staking contract on OLAS VoteWeighting',
}

export default function VotePage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        subtitle="OLAS VoteWeighting"
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Vote' },
        ]}
      />

      <main className="flex-1 py-6">
        <div className="container mx-auto px-4 max-w-2xl">
          <VotePageContent />
        </div>
      </main>
    </div>
  )
}
