import { NextRequest, NextResponse } from 'next/server'
import { getWorkstreamArtifact } from '@/lib/subgraph'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const rootRequestId = searchParams.get('rootRequestId')

  if (!rootRequestId) {
    return NextResponse.json(
      { error: 'rootRequestId is required' },
      { status: 400 }
    )
  }

  try {
    const artifact = await getWorkstreamArtifact(rootRequestId, 'launcher_briefing')
    
    return NextResponse.json({ artifact })
  } catch (error) {
    console.error('Error fetching workstream briefing:', error)
    return NextResponse.json(
      { error: 'Failed to fetch briefing' },
      { status: 500 }
    )
  }
}

