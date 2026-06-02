import { OpenAICompatibleAdapter } from './openai-compatible'
import type { Provider } from '@/types'

export class OpenRouterAdapter extends OpenAICompatibleAdapter {
  constructor(modelId: string, apiKey: string) {
    super(modelId, apiKey, 'https://openrouter.ai/api/v1', {
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
      'X-Title': 'Crucible',
    })
  }
  getProvider(): Provider { return 'openrouter' }
  // OpenRouter proxies to arbitrary models — many (Claude, Gemini, older LLaMA)
  // reject response_format. Rely on system prompts + parseJSON fallback instead.
  protected supportsJsonMode(): boolean { return false }
}
