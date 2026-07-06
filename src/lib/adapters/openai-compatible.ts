import OpenAI from 'openai'
import type {
  AlignmentMessage,
  ThinkingOutput,
} from '@/types'
import type { StreamUsage } from './base'
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
  withRetry,
} from './base'

export abstract class OpenAICompatibleAdapter extends BaseAdapter {
  protected readonly client: OpenAI

  constructor(
    protected readonly modelId: string,
    apiKey: string,
    baseURL: string,
    defaultHeaders?: Record<string, string>,
  ) {
    super()
    this.client = new OpenAI({ apiKey, baseURL, defaultHeaders })
  }

  getModelId(): string { return this.modelId }

  // Subclasses that route to arbitrary/unknown models (OpenRouter, Together) should
  // override this to return false — those providers may surface models that reject
  // the response_format parameter.
  protected supportsJsonMode(): boolean { return true }

  // ─── Phase 1: Thinking ──────────────────────────────────────────────────────

  async think(taskDescription: string, contextText?: string): Promise<ThinkingOutput> {
    const prompt = buildThinkingPrompt(taskDescription, contextText)
    try {
      const res = await this.client.chat.completions.create({
        model:           this.modelId,
        max_tokens:      8192,
        ...(this.supportsJsonMode() && { response_format: { type: 'json_object' } }),
        messages: [
          { role: 'system', content: THINKING_SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
      })
      const text   = res.choices[0]?.message?.content ?? ''
      if (!text.trim()) throw new Error('empty response from model — retrying')
      const tokens = res.usage?.total_tokens ?? 0
      const output = parseThinkingOutput(text, this.getProvider(), this.modelId, tokens)

      // If model returned prose/code instead of JSON, convert it to structured format
      if (isUnparseableThinkingOutput(output)) {
        return await this.convertFreeFormToThinkingJson(text, taskDescription, tokens)
      }
      return output
    } catch (err) {
      throw this.wrapError(err, 'think')
    }
  }

  private async convertFreeFormToThinkingJson(
    freeFormText: string,
    taskDescription: string,
    prevTokens: number,
  ): Promise<ThinkingOutput> {
    try {
      const conversionPrompt = buildThinkingConversionPrompt(freeFormText, taskDescription)
      const res = await this.client.chat.completions.create({
        model:      this.modelId,
        max_tokens: 2048,
        ...(this.supportsJsonMode() && { response_format: { type: 'json_object' } }),
        messages: [{ role: 'user', content: conversionPrompt }],
      })
      const text   = res.choices[0]?.message?.content ?? ''
      const tokens = prevTokens + (res.usage?.total_tokens ?? 0)
      const converted = parseThinkingOutput(text, this.getProvider(), this.modelId, tokens)
      if (isUnparseableThinkingOutput(converted)) {
        return this.cleanFallback(taskDescription, tokens)
      }
      return converted
    } catch {
      return this.cleanFallback(taskDescription, prevTokens)
    }
  }

  private cleanFallback(taskDescription: string, tokens: number): ThinkingOutput {
    return {
      understood_as: taskDescription.length > 0
        ? taskDescription.slice(0, 160)
        : 'Task analysis complete',
      assumptions: [],
      questions: [],
      recommended_approach: 'Approach determined during code generation.',
      risks: [],
      provider:    this.getProvider(),
      model_id:    this.modelId,
      tokens_used: tokens,
    }
  }

  // ─── Phase 1.5: Alignment ───────────────────────────────────────────────────

  async chat(taskDescription: string, otherThinking: ThinkingOutput, myThinking: ThinkingOutput, round: 1 | 2): Promise<AlignmentMessage> {
    const prompt = buildAlignmentPrompt(round, taskDescription, myThinking, otherThinking, undefined, undefined)
    try {
      const text = await this.completeNonStreaming(ALIGNMENT_SYSTEM_PROMPT, prompt)
      if (!text.trim()) throw new Error('empty response from model — retrying')
      const raw  = parseJSON<Record<string, unknown>>(text, 'alignment')
      if (!raw) throw new Error('alignment response parse failed — retrying')
      return this.makeAlignmentMessage(round, this.getProvider() === 'anthropic' ? 'reviewer' : 'primary', raw)
    } catch (err) {
      throw this.wrapError(err, 'chat')
    }
  }

  // ─── Provider primitives ────────────────────────────────────────────────────

  // No response_format here — this primitive backs both object-shaped (spec,
  // cross-review) and array-shaped (review-and-patch hunks) JSON calls, and
  // OpenAI's json_object mode only guarantees a top-level object.
  protected async completeNonStreaming(systemPrompt: string, userMsg: string): Promise<string> {
    try {
      return await withRetry(async () => {
        const res = await this.client.chat.completions.create({
          model:      this.modelId,
          max_tokens: 8192,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userMsg },
          ],
        })
        return res.choices[0]?.message?.content ?? ''
      }, this.retryEmitter)
    } catch (err) {
      throw this.wrapError(err, 'completeNonStreaming')
    }
  }

  // stream() is a one-shot primitive — retry for streaming calls is handled at
  // the generate()/applyPatch()/fixFile() level in BaseAdapter so the token
  // accumulator can be reset on each attempt.
  protected async stream(systemPrompt: string, userMsg: string, onToken: (token: string) => void): Promise<StreamUsage> {
    try {
      let tokensIn        = 0
      let tokensOut       = 0
      let cacheReadTokens = 0

      const s = await this.client.chat.completions.create({
        model:          this.modelId,
        max_tokens:     16384,
        stream:         true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMsg },
        ],
      })
      for await (const chunk of s) {
        const delta = chunk.choices[0]?.delta?.content
        if (delta) onToken(delta)
        if (chunk.usage) {
          tokensIn  = chunk.usage.prompt_tokens     ?? 0
          tokensOut = chunk.usage.completion_tokens ?? 0
          // OpenAI-compatible providers (OpenAI, DeepSeek) report cache hits in
          // prompt_tokens_details.cached_tokens — not typed in chat completions
          // but present at runtime when the provider supports prefix caching.
          const details = (chunk.usage as unknown as Record<string, unknown>)?.prompt_tokens_details as
            { cached_tokens?: number } | undefined
          cacheReadTokens = details?.cached_tokens ?? 0
        }
      }
      return { tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens: 0 }
    } catch (err) {
      throw this.wrapError(err, 'stream')
    }
  }

  // ─── Error wrapper ───────────────────────────────────────────────────────────

  protected wrapError(err: unknown, phase: string): Error {
    const provider = this.getProvider()
    const model    = this.modelId

    if (err instanceof OpenAI.APIError) {
      const hint = err.status === 404
        ? ` — model "${model}" not found. Check Settings.`
        : err.status === 401
        ? ` — invalid API key for ${provider}. Re-connect in Settings.`
        : err.status === 429
        ? ` — rate limit hit. Wait a moment then try again.`
        : ''
      return new Error(`${provider} ${phase} failed (HTTP ${err.status}): ${err.message}${hint}`)
    }

    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'terminated' || msg.includes('terminated')) {
      return new Error(
        `${provider} stream terminated. Model "${model}" may not exist. ` +
        `Go to Settings and verify the model ID.`
      )
    }
    return new Error(`${provider} ${phase} error: ${msg}`)
  }
}
