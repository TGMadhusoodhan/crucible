import { OpenAICompatibleAdapter } from './openai-compatible'
import type { Provider } from '@/types'

export class MistralAdapter extends OpenAICompatibleAdapter {
  constructor(modelId: string, apiKey: string) {
    super(modelId, apiKey, 'https://api.mistral.ai/v1')
  }
  getProvider(): Provider { return 'mistral' }
}
