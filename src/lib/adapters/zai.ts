import { OpenAICompatibleAdapter } from './openai-compatible'
import type { Provider } from '@/types'

export class ZAIAdapter extends OpenAICompatibleAdapter {
  constructor(modelId: string, apiKey: string) {
    super(modelId, apiKey, 'https://api.z.ai/api/paas/v4')
  }
  getProvider(): Provider { return 'zai' }
}
