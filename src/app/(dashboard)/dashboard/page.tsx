import { PipelineView }      from '@/components/pipeline/PipelineView'
import { ConversationPanel } from '@/components/conversation/ConversationPanel'
import { ProjectNavigator }  from '@/components/shared/ProjectNavigator'

export default function DashboardPage() {
  return (
    <>
      {/* Left: project navigator — fixed narrow column */}
      <div className="w-56 shrink-0">
        <ProjectNavigator />
      </div>

      {/* Centre: 4-phase pipeline interaction */}
      <div className="flex-1 min-w-0 border-r border-zinc-800">
        <PipelineView />
      </div>

      {/* Right: conversation event timeline */}
      <div className="w-80 shrink-0">
        <ConversationPanel />
      </div>
    </>
  )
}
