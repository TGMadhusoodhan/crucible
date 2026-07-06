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

  // ─── Error helper ───────────────────────────────────────────────────────────

  private wrapErr(err: unknown, phase: string): Error {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('403') || msg.includes('401')) {
      return new Error(`Google ${phase} failed — invalid API key. Re-connect in Settings. (${msg})`)
    }
    if (msg.includes('404')) {
      return new Error(`Google ${phase} failed — model "${this.modelId}" not found. Check model ID. (${msg})`)
    }
    if (msg.includes('429')) {
      return new Error(`Google ${phase} failed — rate limit hit. Wait a moment then try again.`)
    }
    return new Error(`Google ${phase} error: ${msg}`)
  }

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
    try {
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
    } catch (err) {
      throw this.wrapErr(err, 'think')
    }
  }

  // ─── Phase 1.5: Alignment ───────────────────────────────────────────────────

  async chat(taskDescription: string, otherThinking: ThinkingOutput, myThinking: ThinkingOutput, round: 1 | 2): Promise<AlignmentMessage> {
    try {
      const prompt = buildAlignmentPrompt(round, taskDescription, myThinking, otherThinking, undefined, undefined)
      const text = await this.completeNonStreaming(ALIGNMENT_SYSTEM_PROMPT, prompt)
      const raw = parseJSON<Record<string, unknown>>(text, 'alignment')
      if (!raw) throw new Error('alignment response parse failed — retrying')
      return this.makeAlignmentMessage(round, 'primary', raw)
    } catch (err) {
      throw this.wrapErr(err, 'chat')
    }
  }

  // ─── Provider primitives ────────────────────────────────────────────────────

  protected async completeNonStreaming(systemPrompt: string, userMsg: string): Promise<string> {
    try {
      const { text } = await this.geminiGenerate(systemPrompt, userMsg, 8192)
      return text
    } catch (err) {
      throw this.wrapErr(err, 'completeNonStreaming')
    }
  }

  protected async stream(systemPrompt: string, userMsg: string, onToken: (token: string) => void): Promise<void> {
    try {
      const res = await fetch(
        `${this.baseUrl}/models/${this.modelId}:streamGenerateContent?key=${this.apiKey}&alt=sse`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents:          [{ role: 'user', parts: [{ text: userMsg }] }],
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
            if (text) onToken(text)
          } catch { /* skip malformed SSE chunks */ }
        }
      }
    } catch (err) {
      throw this.wrapErr(err, 'stream')
    }
  }
}
