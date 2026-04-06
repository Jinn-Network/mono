import { Metadata } from 'next'
import { SiteHeader } from '@/components/site-header'
import { DashboardView } from '@/components/dashboard-view'

export const metadata: Metadata = {
  title: 'Home | Jinn Explorer',
  description: 'Jinn Explorer dashboard - view workstreams, job definitions, and artifacts',
}

export default function Home() {
  return (
    <>
      <SiteHeader 
        title="Home"
      />
      <DashboardView />
    </>
  );
}