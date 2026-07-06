import Anthropic from '@anthropic-ai/sdk'
import type {
  AlignmentMessage,
  Provider,
  ThinkingOutput,
} from '@/types'
import {
  ALIGNMENT_SYSTEM_PROMPT,
  THINKING_SYSTEM_PROMPT,
  BaseAdapter,
  buildAlignmentPrompt,
  buildThinkingConversionPrompt,
  buildThinkingPrompt,
  isUnparseableThinkingOutput,
  parseJSON,
  parseThinkingOutput,
} from './base'

function wrapErr(err: unknown, phase: string, modelId: string): Error {
  if (err instanceof Anthropic.APIError) {
    const hint = err.status === 404
      ? ` — model "${modelId}" not found. Check model ID in project settings.`
      : err.status === 401
      ? ` — invalid Anthropic API key. Re-connect in Settings.`
      : err.status === 429
      ? ` — rate limit hit. Wait a moment then try again.`
      : ''
    return new Error(`Anthropic ${phase} failed (HTTP ${err.status}): ${err.message}${hint}`)
  }
  return new Error(`Anthropic ${phase} error: ${err instanceof Error ? err.message : String(err)}`)
}

export class ClaudeAdapter extends BaseAdapter {
  private readonly client: Anthropic

  constructor(
    private readonly modelId: string,
    apiKey: string,
  ) {
    super()
    this.client = new Anthropic({ apiKey })
  }

  getProvider(): Provider { return 'anthropic' }
  getModelId(): string    { return this.modelId }

  // ─── Phase 1: Thinking ──────────────────────────────────────────────────────

  async think(taskDescription: string, contextText?: string): Promise<ThinkingOutput> {
    const prompt = buildThinkingPrompt(taskDescription, contextText)
    try {
      const res = await this.client.messages.create({
        model:      this.modelId,
        max_tokens: 8192,
        system:     THINKING_SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: prompt }],
      })
      const block  = res.content[0]
      const text   = block?.type === 'text' ? block.text : ''
      if (!text.trim()) throw new Error('empty response from model — retrying')
      const tokens = res.usage.input_tokens + res.usage.output_tokens
      const output = parseThinkingOutput(text, 'anthropic', this.modelId, tokens)

      // If model returned prose/code instead of JSON, convert it to structured format
      if (isUnparseableThinkingOutput(output)) {
        return await this.convertFreeFormToThinkingJson(text, taskDescription, tokens)
      }
      return output
    } catch (err) {
      throw wrapErr(err, 'think', this.modelId)
    }
  }

  private async convertFreeFormToThinkingJson(
    freeFormText: string,
    taskDescription: string,
    prevTokens: number,
  ): Promise<ThinkingOutput> {
    try {
      const conversionPrompt = buildThinkingConversionPrompt(freeFormText, taskDescription)
      const res = await this.client.messages.create({
        model:      this.modelId,
        max_tokens: 2048,
        messages:   [{ role: 'user', content: conversionPrompt }],
      })
      const block  = res.content[0]
      const text   = block?.type === 'text' ? block.text : ''
      const tokens = prevTokens + res.usage.input_tokens + res.usage.output_tokens
      const converted = parseThinkingOutput(text, 'anthropic', this.modelId, tokens)
      // If conversion also failed, return a clean fallback — never put raw code in the UI
      if (isUnparseableThinkingOutput(converted)) {
        return this.cleanFallback(taskDescription, tokens, 'anthropic')
      }
      return converted
    } catch {
      return this.cleanFallback(taskDescription, prevTokens, 'anthropic')
    }
  }

  private cleanFallback(taskDescription: string, tokens: number, provider: Provider): ThinkingOutput {
    return {
      understood_as: taskDescription.length > 0
        ? taskDescription.slice(0, 160)
        : 'Task analysis complete',
      assumptions: [],
      questions: [],
      recommended_approach: 'Approach determined during code generation.',
      risks: [],
      provider,
      model_id: this.modelId,
      tokens_used: tokens,
    }
  }

  // ─── Phase 1.5: Alignment ───────────────────────────────────────────────────

  async chat(taskDescription: string, otherThinking: ThinkingOutput, myThinking: ThinkingOutput, round: 1 | 2): Promise<AlignmentMessage> {
    const prompt = buildAlignmentPrompt(round, taskDescription, myThinking, otherThinking, undefined, undefined)
    try {
      const text = await this.completeNonStreaming(ALIGNMENT_SYSTEM_PROMPT, prompt)
      if (!text.trim()) throw new Error('empty response from model — retrying')
      const raw = parseJSON<Record<string, unknown>>(text, 'alignment')
      if (!raw) throw new Error('alignment response parse failed — retrying')
      return this.makeAlignmentMessage(round, 'reviewer', raw)
    } catch (err) {
      throw wrapErr(err, 'chat', this.modelId)
    }
  }

  // ─── Provider primitives ────────────────────────────────────────────────────

  protected async completeNonStreaming(systemPrompt: string, userMsg: string): Promise<string> {
    try {
      const res = await this.client.messages.create({
        model:      this.modelId,
        max_tokens: 8192,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userMsg }],
      })
      const block = res.content[0]
      return block?.type === 'text' ? block.text : ''
    } catch (err) {
      throw wrapErr(err, 'completeNonStreaming', this.modelId)
    }
  }

  protected async stream(systemPrompt: string, userMsg: string, onToken: (token: string) => void): Promise<void> {
    try {
      const stream = this.client.messages.stream({
        model:      this.modelId,
        max_tokens: 32768,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userMsg }],
      })
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          onToken(event.delta.text)
        }
      }
    } catch (err) {
      throw wrapErr(err, 'stream', this.modelId)
    }
  }
}
