import { OpenAICompatibleAdapter } from './openai-compatible'
import type { Provider } from '@/types'

// DeepSeek API requires lowercase model IDs (deepseek-v4-pro, not DeepSeek-V4-Pro).
// Normalize here so projects created with the old capitalized IDs still work.
function normalizeDeepSeekModelId(id: string): string {
  return id.toLowerCase()
}

export class DeepSeekAdapter extends OpenAICompatibleAdapter {
  constructor(modelId: string, apiKey: string) {
    super(normalizeDeepSeekModelId(modelId), apiKey, 'https://api.deepseek.com/v1')
  }
  getProvider(): Provider { return 'deepseek' }
}
