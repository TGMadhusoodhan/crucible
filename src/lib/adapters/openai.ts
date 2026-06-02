import { OpenAICompatibleAdapter } from './openai-compatible'
import type { Provider } from '@/types'

export class OpenAIAdapter extends OpenAICompatibleAdapter {
  constructor(modelId: string, apiKey: string) {
    super(modelId, apiKey, 'https://api.openai.com/v1')
  }
  getProvider(): Provider { return 'openai' }
}
