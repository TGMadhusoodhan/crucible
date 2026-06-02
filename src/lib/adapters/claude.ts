import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages'
import type {
  AlignmentMessage,
  PipelineContext,
  Provider,
  ReviewPayload,
  SelfCheckOutput,
  SpecDocument,
  ThinkingOutput,
} from '@/types'
import {
  ALIGNMENT_SYSTEM_PROMPT,
  GENERATION_SYSTEM_PROMPT,
  REVIEWER_SYSTEM_PROMPT,
  SELF_CHECK_SYSTEM_PROMPT,
  THINKING_SYSTEM_PROMPT,
  BaseAdapter,
  buildAlignmentPrompt,
  buildGenerationPrompt,
  buildReviewPrompt,
  buildSelfCheckPrompt,
  buildThinkingConversionPrompt,
  buildThinkingPrompt,
  isUnparseableThinkingOutput,
  parseJSON,
  parseReviewPayload,
  parseSelfCheckOutput,
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

  async chat(round: 1 | 2, taskDescription: string, myThinking: ThinkingOutput, otherThinking: ThinkingOutput, previousMessages?: AlignmentMessage[], contextText?: string): Promise<AlignmentMessage> {
    const prompt = buildAlignmentPrompt(round, taskDescription, myThinking, otherThinking, previousMessages, contextText)
    try {
      const res = await this.client.messages.create({
        model:      this.modelId,
        max_tokens: 2048,
        system:     ALIGNMENT_SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: prompt }],
      })
      const block = res.content[0]
      const text  = block?.type === 'text' ? block.text : ''
      if (!text.trim()) throw new Error('empty response from model — retrying')
      const raw   = parseJSON<Record<string, unknown>>(text, 'alignment')
      if (!raw) throw new Error('alignment response parse failed — retrying')
      return this.makeAlignmentMessage(round, 'reviewer', raw)
    } catch (err) {
      throw wrapErr(err, 'chat', this.modelId)
    }
  }

  // ─── Phase 3: Generation ────────────────────────────────────────────────────

  async *generate(prompt: string, ctx: PipelineContext): AsyncGenerator<string> {
    const isPatch = prompt.startsWith('PATCH MODE')
    const messages: MessageParam[] = isPatch
      ? []
      : ctx.history
          .filter(m => m.role !== 'system')
          .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    messages.push({ role: 'user', content: prompt })

    try {
      const stream = this.client.messages.stream({
        model:      this.modelId,
        max_tokens: 32768,
        system:     GENERATION_SYSTEM_PROMPT,
        messages,
      })
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text
        }
      }
    } catch (err) {
      throw wrapErr(err, 'generate', this.modelId)
    }
  }

  // ─── Phase 3: Self-Check ────────────────────────────────────────────────────

  async selfCheck(code: string, spec: SpecDocument, pass: 1 | 2, previousIssues?: import('@/types').SelfCheckIssue[]): Promise<SelfCheckOutput> {
    const MAX_SC_CHARS = 20_000
    const codeForCheck = code.length > MAX_SC_CHARS
      ? code.slice(0, MAX_SC_CHARS) + '\n// [truncated — full code in output layer]'
      : code
    const prompt = buildSelfCheckPrompt(codeForCheck, spec, pass, previousIssues)
    try {
      const res = await this.client.messages.create({
        model:      this.modelId,
        max_tokens: 4096,
        system:     SELF_CHECK_SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: prompt }],
      })
      const block = res.content[0]
      const text  = block?.type === 'text' ? block.text : ''
      if (!text.trim()) throw new Error('empty response from model — retrying')
      return parseSelfCheckOutput(text, pass)
    } catch (err) {
      throw wrapErr(err, 'selfCheck', this.modelId)
    }
  }

  // ─── Phase 3: Review ────────────────────────────────────────────────────────

  async review(code: string, spec: SpecDocument, round: number, previousReview?: ReviewPayload): Promise<ReviewPayload> {
    const prompt = buildReviewPrompt(code, spec, round, previousReview)
    try {
      const res = await this.client.messages.create({
        model:      this.modelId,
        max_tokens: 8192,
        system:     REVIEWER_SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: prompt }],
      })
      const block = res.content[0]
      const text  = block?.type === 'text' ? block.text : ''
      if (!text.trim()) throw new Error('empty response from model — retrying')
      return parseReviewPayload(text, round)
    } catch (err) {
      throw wrapErr(err, 'review', this.modelId)
    }
  }
}
