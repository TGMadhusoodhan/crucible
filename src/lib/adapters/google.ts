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

type GeminiContent = { role: 'user' | 'model'; parts: Array<{ text: string }> }
type GeminiStreamChunk = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>
}
type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  usageMetadata?: { totalTokenCount?: number }
}

export class GoogleAdapter extends BaseAdapter {
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta'

  constructor(
    private readonly modelId: string,
    private readonly apiKey: string,
  ) {
    super()
  }

  getProvider(): Provider { return 'google' }
  getModelId(): string    { return this.modelId }

  private async geminiGenerate(
    systemPrompt: string,
    userPrompt:   string,
    maxTokens = 8192,
  ): Promise<{ text: string; tokens: number }> {
    const res = await fetch(
      `${this.baseUrl}/models/${this.modelId}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents:          [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig:  { maxOutputTokens: maxTokens },
        }),
      },
    )
    if (!res.ok) throw new Error(`Google API error ${res.status}: ${await res.text()}`)
    const data   = await res.json() as GeminiResponse
    const text   = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    if (!text.trim()) throw new Error('empty response from Google model — retrying')
    const tokens = data.usageMetadata?.totalTokenCount ?? 0
    return { text, tokens }
  }

  // ─── Phase 1: Thinking ──────────────────────────────────────────────────────

  async think(taskDescription: string, contextText?: string): Promise<ThinkingOutput> {
    const prompt = buildThinkingPrompt(taskDescription, contextText)
    const { text, tokens } = await this.geminiGenerate(THINKING_SYSTEM_PROMPT, prompt, 8192)
    const output = parseThinkingOutput(text, 'google', this.modelId, tokens)
    if (isUnparseableThinkingOutput(output)) {
      try {
        const conversionPrompt = buildThinkingConversionPrompt(text, taskDescription)
        const { text: t2, tokens: t2tok } = await this.geminiGenerate('', conversionPrompt, 2048)
        const converted = parseThinkingOutput(t2, 'google', this.modelId, tokens + t2tok)
        if (!isUnparseableThinkingOutput(converted)) return converted
      } catch { /* fall through */ }
      return { understood_as: taskDescription.slice(0, 120), assumptions: [], questions: [],
        recommended_approach: text.slice(0, 800), risks: [], provider: 'google',
        model_id: this.modelId, tokens_used: tokens }
    }
    return output
  }

  // ─── Phase 1.5: Alignment ───────────────────────────────────────────────────

  async chat(round: 1 | 2, taskDescription: string, myThinking: ThinkingOutput, otherThinking: ThinkingOutput, previousMessages?: AlignmentMessage[], contextText?: string): Promise<AlignmentMessage> {
    const prompt = buildAlignmentPrompt(round, taskDescription, myThinking, otherThinking, previousMessages, contextText)
    const { text } = await this.geminiGenerate(ALIGNMENT_SYSTEM_PROMPT, prompt, 2048)
    const raw = parseJSON<Record<string, unknown>>(text, 'alignment')
    if (!raw) throw new Error('alignment response parse failed — retrying')
    return this.makeAlignmentMessage(round, 'primary', raw)
  }

  // ─── Phase 3: Generation ────────────────────────────────────────────────────

  async *generate(prompt: string, ctx: PipelineContext): AsyncGenerator<string> {
    const isPatch = prompt.startsWith('PATCH MODE')
    const contents: GeminiContent[] = isPatch
      ? []
      : ctx.history
          .filter(m => m.role !== 'system')
          .map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          }))
    contents.push({ role: 'user', parts: [{ text: prompt }] })

    const res = await fetch(
      `${this.baseUrl}/models/${this.modelId}:streamGenerateContent?key=${this.apiKey}&alt=sse`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: GENERATION_SYSTEM_PROMPT }] },
          contents,
          generationConfig:  { maxOutputTokens: 32768 },
        }),
      },
    )

    if (!res.ok || !res.body) throw new Error(`Google API error ${res.status}: ${await res.text()}`)

    const reader  = res.body.getReader()
    const decoder = new TextDecoder()
    let   buffer  = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const chunk = JSON.parse(line.slice(6)) as GeminiStreamChunk
          const text  = chunk.candidates?.[0]?.content?.parts?.[0]?.text
          if (text) yield text
        } catch { /* skip malformed SSE chunks */ }
      }
    }
  }

  // ─── Phase 3: Self-Check ────────────────────────────────────────────────────

  async selfCheck(code: string, spec: SpecDocument, pass: 1 | 2, previousIssues?: import('@/types').SelfCheckIssue[]): Promise<SelfCheckOutput> {
    const MAX_SC_CHARS = 20_000
    const codeForCheck = code.length > MAX_SC_CHARS
      ? code.slice(0, MAX_SC_CHARS) + '\n// [truncated — full code in output layer]'
      : code
    const prompt = buildSelfCheckPrompt(codeForCheck, spec, pass, previousIssues)
    const { text } = await this.geminiGenerate(SELF_CHECK_SYSTEM_PROMPT, prompt, 4096)
    return parseSelfCheckOutput(text, pass)
  }

  // ─── Phase 3: Review ────────────────────────────────────────────────────────

  async review(code: string, spec: SpecDocument, round: number, previousReview?: ReviewPayload): Promise<ReviewPayload> {
    const prompt = buildReviewPrompt(code, spec, round, previousReview)
    const { text } = await this.geminiGenerate(REVIEWER_SYSTEM_PROMPT, prompt, 8192)
    return parseReviewPayload(text, round)
  }
}
