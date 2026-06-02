import { auth } from '@clerk/nextjs/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSessionState } from '@/lib/pipeline/orchestrator'
import {
  getSessionEvents,
  getEventFullContent,
  getPhaseTimeline,
  getSessionSummary,
} from '@/lib/conversation/event-log'
import type { ApiResponse } from '@/types'

// GET /api/conversation/:sessionId
// Query params:
//   view=timeline   — PhaseGroup[] for conversation tab
//   view=events     — flat ConversationEvent[] list
//   view=summary    — SessionSummary stats only
//   since=<ISO>     — return only events after this timestamp (incremental polling)
//   expand=true     — include fullContent in events
//   eventId=<id>    — return fullContent for a single event
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse<ApiResponse>> {
  try {
    const { userId: clerkUserId } = await auth()
    if (!clerkUserId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const { sessionId } = await params
    const state = await getSessionState(sessionId)
    if (!state) return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 })
    if (state.userId !== clerkUserId) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const view    = searchParams.get('view') ?? 'events'
    const since   = searchParams.get('since') ?? undefined
    const expand  = searchParams.get('expand') === 'true'
    const eventId = searchParams.get('eventId')

    const projectId = state.projectId

    // Single event full content (for expand-on-click)
    if (eventId) {
      const fullContent = await getEventFullContent(projectId, eventId)
      return NextResponse.json({ success: true, data: { fullContent } })
    }

    switch (view) {
      case 'timeline': {
        const timeline = await getPhaseTimeline(projectId)
        return NextResponse.json({ success: true, data: timeline })
      }

      case 'summary': {
        const summary = await getSessionSummary(projectId)
        return NextResponse.json({ success: true, data: summary })
      }

      case 'events':
      default: {
        const events = await getSessionEvents(projectId, { since, expand })
        return NextResponse.json({ success: true, data: events })
      }
    }
  } catch (err) {
    console.error('GET /api/conversation/[sessionId]:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(): Promise<NextResponse<ApiResponse>> {
  return NextResponse.json({ success: false, error: 'Use GET' }, { status: 405 })
}
