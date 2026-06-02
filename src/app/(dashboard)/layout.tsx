import { PipelineProvider } from '@/store'
import { AppNav } from '@/components/shared/AppNav'
import { BudgetBar } from '@/components/shared/BudgetBar'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <PipelineProvider>
      <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
        <AppNav />
        <BudgetBar />
        <div className="flex flex-1 overflow-hidden">
          {children}
        </div>
      </div>
    </PipelineProvider>
  )
}
