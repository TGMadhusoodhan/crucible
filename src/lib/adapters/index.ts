import { ClaudeAdapter } from './claude'
import { DeepSeekAdapter } from './deepseek'
import { GoogleAdapter } from './google'
import { MistralAdapter } from './mistral'
import { OpenAIAdapter } from './openai'
import { OpenAICompatibleAdapter } from './openai-compatible'
import { OpenRouterAdapter } from './openrouter'
import type { ModelAdapter, Provider } from '@/types'

class GroqAdapter extends OpenAICompatibleAdapter {
  constructor(modelId: string, apiKey: string) {
    super(modelId, apiKey, 'https://api.groq.com/openai/v1')
  }
  getProvider(): Provider { return 'groq' }
}

class TogetherAdapter extends OpenAICompatibleAdapter {
  constructor(modelId: string, apiKey: string) {
    super(modelId, apiKey, 'https://api.together.xyz/v1')
  }
  getProvider(): Provider { return 'together' }
  protected supportsJsonMode(): boolean { return false }
}

export function getAdapter(provider: Provider, modelId: string, apiKey: string): ModelAdapter {
  switch (provider) {
    case 'anthropic':   return new ClaudeAdapter(modelId, apiKey)
    case 'openai':      return new OpenAIAdapter(modelId, apiKey)
    case 'deepseek':    return new DeepSeekAdapter(modelId, apiKey)
    case 'google':      return new GoogleAdapter(modelId, apiKey)
    case 'mistral':     return new MistralAdapter(modelId, apiKey)
    case 'openrouter':  return new OpenRouterAdapter(modelId, apiKey)
    case 'groq':        return new GroqAdapter(modelId, apiKey)
    case 'together':    return new TogetherAdapter(modelId, apiKey)
    default: {
      const _exhaustive: never = provider
      throw new Error(`Unknown provider: ${String(_exhaustive)}`)
    }
  }
}

export {
  ClaudeAdapter,
  DeepSeekAdapter,
  GoogleAdapter,
  MistralAdapter,
  OpenAIAdapter,
  OpenRouterAdapter,
}
export type { ModelAdapter }
