import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { LLMConfig, LLMProvider } from '../../../src/shared/types'

export interface StreamEvent {
  type: 'token' | 'done' | 'error'
  token?: string
  fullText?: string
  error?: string
}

export class LLMClient {
  private anthropic: Anthropic | null = null
  private openai: OpenAI | null = null
  private provider: LLMProvider = 'anthropic'

  configure(config: LLMConfig): void {
    this.provider = config.provider

    if (config.provider === 'anthropic') {
      this.anthropic = new Anthropic({ apiKey: config.apiKey })
      this.openai = null
    } else {
      this.openai = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL || undefined,
      })
      this.anthropic = null
    }
  }

  isConfigured(): boolean {
    return this.anthropic !== null || this.openai !== null
  }

  /** Stream a completion, calling onEvent for each token */
  async streamCompletion(
    system: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    model: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<string> {
    if (this.provider === 'anthropic' && this.anthropic) {
      return this.streamAnthropic(system, messages, model, onEvent, signal)
    } else if (this.openai) {
      return this.streamOpenAI(system, messages, model, onEvent, signal)
    }
    throw new Error('LLM client not configured')
  }

  /** Non-streaming completion for sub-calls */
  async complete(
    system: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    model: string,
    signal?: AbortSignal
  ): Promise<string> {
    if (this.provider === 'anthropic' && this.anthropic) {
      const response = await this.anthropic.messages.create({
        model,
        system,
        messages,
        max_tokens: 4096,
        temperature: 0,
      })
      if (signal?.aborted) throw new Error('Aborted')
      const block = response.content[0]
      return block.type === 'text' ? block.text : ''
    } else if (this.openai) {
      const response = await this.openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: system },
          ...messages,
        ],
        max_tokens: 4096,
        temperature: 0,
      })
      if (signal?.aborted) throw new Error('Aborted')
      return response.choices[0]?.message?.content || ''
    }
    throw new Error('LLM client not configured')
  }

  private async streamAnthropic(
    system: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    model: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<string> {
    let fullText = ''

    const stream = this.anthropic!.messages.stream({
      model,
      system,
      messages,
      max_tokens: 4096,
      temperature: 0,
    })

    // Handle abort
    if (signal) {
      signal.addEventListener('abort', () => stream.abort(), { once: true })
    }

    for await (const event of stream) {
      if (signal?.aborted) {
        stream.abort()
        throw new Error('Aborted')
      }

      if (event.type === 'content_block_delta') {
        const delta = event.delta as any
        if (delta.type === 'text_delta' && delta.text) {
          fullText += delta.text
          onEvent({ type: 'token', token: delta.text })
        }
      }
    }

    onEvent({ type: 'done', fullText })
    return fullText
  }

  private async streamOpenAI(
    system: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    model: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<string> {
    let fullText = ''

    const stream = await this.openai!.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        ...messages,
      ],
      max_tokens: 4096,
      temperature: 0,
      stream: true,
    })

    for await (const chunk of stream) {
      if (signal?.aborted) throw new Error('Aborted')

      const content = chunk.choices[0]?.delta?.content
      if (content) {
        fullText += content
        onEvent({ type: 'token', token: content })
      }
    }

    onEvent({ type: 'done', fullText })
    return fullText
  }
}
