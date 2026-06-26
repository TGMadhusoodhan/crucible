import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { generateId } from '@/lib/utils'
import type {
  AlignmentMessage,
  CoderVerification,
  DialogueSummary,
  PipelineContext,
  Provider,
  ReviewEdit,
  ReviewPayload,
  SelfCheckOutput,
  SpecDocument,
  ThinkingOutput,
} from '@/types'
import {
  ALIGNMENT_SYSTEM_PROMPT,
  CODER_DIALOGUE_SYSTEM_PROMPT,
  CODER_VERIFY_SYSTEM_PROMPT,
  GENERATION_SYSTEM_PROMPT,
  REVIEWER_DIALOGUE_SYSTEM_PROMPT,
  REVIEWER_EDIT_SYSTEM_PROMPT,
  REVIEWER_SYSTEM_PROMPT,
  SELF_CHECK_SYSTEM_PROMPT,
  THINKING_SYSTEM_PROMPT,
  BaseAdapter,
  buildAlignmentPrompt,
  buildCoderDialoguePrompt,
  buildCoderVerifyPrompt,
  buildGenerationPrompt,
  buildOpenAIMessages,
  buildReviewPrompt,
  buildReviewerDialoguePrompt,
  buildReviewerEditPrompt,
  buildSelfCheckPrompt,
  buildThinkingConversionPrompt,
  buildThinkingPrompt,
  isUnparseableThinkingOutput,
  parseCoderVerification,
  parseJSON,
  parseReviewEdit,
  parseReviewPayload,
  parseReviewerDialogueResponse,
  parseSelfCheckOutput,
  parseThinkingOutput,
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

  async chat(round: 1 | 2, taskDescription: string, myThinking: ThinkingOutput, otherThinking: ThinkingOutput, previousMessages?: AlignmentMessage[], contextText?: string): Promise<AlignmentMessage> {
    const prompt = buildAlignmentPrompt(round, taskDescription, myThinking, otherThinking, previousMessages, contextText)
    try {
      const res = await this.client.chat.completions.create({
        model:           this.modelId,
        max_tokens:      2048,
        ...(this.supportsJsonMode() && { response_format: { type: 'json_object' } }),
        messages: [
          { role: 'system', content: ALIGNMENT_SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
      })
      const text = res.choices[0]?.message?.content ?? ''
      if (!text.trim()) throw new Error('empty response from model — retrying')
      const raw  = parseJSON<Record<string, unknown>>(text, 'alignment')
      if (!raw) throw new Error('alignment response parse failed — retrying')
      return this.makeAlignmentMessage(round, this.getProvider() === 'anthropic' ? 'reviewer' : 'primary', raw)
    } catch (err) {
      throw this.wrapError(err, 'chat')
    }
  }

  // ─── Phase 3: Generation ────────────────────────────────────────────────────

  async *generate(prompt: string, ctx: PipelineContext): AsyncGenerator<string> {
    // PATCH MODE prompts are self-contained (code + issues inline) — conversation
    // history adds noise and confuses the model into treating it as a fresh generation.
    const isPatch  = prompt.startsWith('PATCH MODE')
    const history  = isPatch ? [] : ctx.history.map(m => ({ role: m.role, content: m.content }))
    const messages = buildOpenAIMessages(history, prompt, GENERATION_SYSTEM_PROMPT) as ChatCompletionMessageParam[]

    try {
      const stream = await this.client.chat.completions.create({
        model:      this.modelId,
        max_tokens: 16384,
        stream:     true,
        messages,
      })
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content
        if (delta) yield delta
      }
    } catch (err) {
      throw this.wrapError(err, 'generate')
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
      const res = await this.client.chat.completions.create({
        model:           this.modelId,
        max_tokens:      4096,
        ...(this.supportsJsonMode() && { response_format: { type: 'json_object' } }),
        messages: [
          { role: 'system', content: SELF_CHECK_SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
      })
      const text = res.choices[0]?.message?.content ?? ''
      if (!text.trim()) throw new Error('empty response from model — retrying')
      return parseSelfCheckOutput(text, pass)
    } catch (err) {
      throw this.wrapError(err, 'selfCheck')
    }
  }

  // ─── Phase 3: Review ────────────────────────────────────────────────────────

  async review(code: string, spec: SpecDocument, round: number, previousReview?: ReviewPayload): Promise<ReviewPayload> {
    const prompt = buildReviewPrompt(code, spec, round, previousReview)
    try {
      const res = await this.client.chat.completions.create({
        model:           this.modelId,
        max_tokens:      8192,
        ...(this.supportsJsonMode() && { response_format: { type: 'json_object' } }),
        messages: [
          { role: 'system', content: REVIEWER_SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
      })
      const text = res.choices[0]?.message?.content ?? ''
      if (!text.trim()) throw new Error('empty response from model — retrying')
      return parseReviewPayload(text, round)
    } catch (err) {
      throw this.wrapError(err, 'review')
    }
  }

  // ─── Phase 3b: Reviewer Edit ────────────────────────────────────────────────

  async reviewerEdit(code: string, spec: SpecDocument, review: ReviewPayload, round: number): Promise<ReviewEdit> {
    const prompt = buildReviewerEditPrompt(code, spec, review)
    try {
      const res = await this.client.chat.completions.create({
        model:      this.modelId,
        max_tokens: 8192,
        ...(this.supportsJsonMode() && { response_format: { type: 'json_object' } }),
        messages: [
          { role: 'system', content: REVIEWER_EDIT_SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
      })
      const text = res.choices[0]?.message?.content ?? ''
      return parseReviewEdit(text)
    } catch (err) {
      throw this.wrapError(err, `reviewerEdit:round${round}`)
    }
  }

  // ─── Phase 3b: Coder Verify ─────────────────────────────────────────────────

  async coderVerify(originalCode: string, edit: ReviewEdit, mergedCode: string, review: ReviewPayload): Promise<CoderVerification> {
    const prompt = buildCoderVerifyPrompt(originalCode, edit, mergedCode, review)
    try {
      const res = await this.client.chat.completions.create({
        model:      this.modelId,
        max_tokens: 4096,
        ...(this.supportsJsonMode() && { response_format: { type: 'json_object' } }),
        messages: [
          { role: 'system', content: CODER_VERIFY_SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
      })
      const text = res.choices[0]?.message?.content ?? ''
      return parseCoderVerification(text)
    } catch (err) {
      throw this.wrapError(err, 'coderVerify')
    }
  }

  // ─── Phase 3b: Coder Dialogue ───────────────────────────────────────────────

  async coderDialogue(code: string, dialogue: DialogueSummary, verification: CoderVerification): Promise<string> {
    const prompt = buildCoderDialoguePrompt(code, dialogue, verification)
    try {
      const res = await this.client.chat.completions.create({
        model:      this.modelId,
        max_tokens: 512,
        messages: [
          { role: 'system', content: CODER_DIALOGUE_SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
      })
      return res.choices[0]?.message?.content?.trim() ?? 'No response'
    } catch (err) {
      throw this.wrapError(err, 'coderDialogue')
    }
  }

  // ─── Phase 3b: Reviewer Dialogue ────────────────────────────────────────────

  async reviewerDialogue(code: string, dialogue: DialogueSummary, review: ReviewPayload): Promise<{ response: string; resolved: boolean }> {
    const prompt = buildReviewerDialoguePrompt(code, dialogue, review)
    try {
      const res = await this.client.chat.completions.create({
        model:      this.modelId,
        max_tokens: 512,
        ...(this.supportsJsonMode() && { response_format: { type: 'json_object' } }),
        messages: [
          { role: 'system', content: REVIEWER_DIALOGUE_SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
      })
      const text = res.choices[0]?.message?.content ?? ''
      return parseReviewerDialogueResponse(text)
    } catch (err) {
      throw this.wrapError(err, 'reviewerDialogue')
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
