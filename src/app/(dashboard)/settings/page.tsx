import { CredentialsManager } from '@/components/shared/CredentialsManager'
import { BudgetSettings } from '@/components/shared/BudgetSettings'

export default function SettingsPage() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-10 space-y-10">
        <CredentialsManager />
        <BudgetSettings />
      </div>
    </div>
  )
}
