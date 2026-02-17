import { WebContentsView } from 'electron'
import type { TabManager } from '../tabs/TabManager'
import type { LLMConfig, IterationRecord, BlockResult, TaskState, TabChange } from '../../../src/shared/types'
import { IPC } from '../../../src/shared/ipc-channels'
import { REPLRuntime } from './repl'
import { LLMClient } from './llm-client'
import { extractCodeBlocks } from './parser'
import { TaskTracker } from './task-tracker'
import { getSystemPrompt, getContinuationPrompt, buildMessages } from './context'
import { MAX_ITERATIONS, MAX_SUB_CALLS, MAX_NO_CODE_CONTINUATIONS, PREVIEW_MAX_CHARS } from './caps'

export class RLMEngine {
  private tabManager: TabManager
  private commandCenterView: WebContentsView
  private llmClient: LLMClient
  private config: LLMConfig
  private taskTracker: TaskTracker = new TaskTracker()
  private repl: REPLRuntime | null = null
  private abortController: AbortController | null = null
  private subCallCount = 0
  private status: 'idle' | 'running' | 'complete' | 'cancelled' | 'error' = 'idle'
  private pendingConfirmation: ((approved: boolean) => void) | null = null

  constructor(tabManager: TabManager, commandCenterView: WebContentsView, config: LLMConfig) {
    this.tabManager = tabManager
    this.commandCenterView = commandCenterView
    this.llmClient = new LLMClient()
    this.config = config
    this.llmClient.configure(config)
  }

  updateConfig(config: LLMConfig): void {
    this.config = config
    this.llmClient.configure(config)
  }

  private emit(channel: string, data: unknown): void {
    if (!this.commandCenterView.webContents.isDestroyed()) {
      this.commandCenterView.webContents.send(channel, data)
    }
  }

  /** Run a task — the main Algorithm 1 loop */
  async runTask(message: string): Promise<void> {
    if (this.status === 'running') {
      this.emit(IPC.RLM_ERROR, { error: 'A task is already running. Cancel it first.' })
      return
    }

    this.status = 'running'
    this.subCallCount = 0
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    const maxIter = this.config.maxIterations || MAX_ITERATIONS
    this.taskTracker.setTask(message, maxIter)

    // Initialize fresh REPL
    this.repl = new REPLRuntime(this.tabManager, {
      onLog: (msg) => this.emit(IPC.RLM_LOG, { message: msg }),
      onSetFinal: (_value) => { /* handled via repl.isFinalCalled() */ },
      onSubCall: (prompt, data) => this.handleSubCall(prompt, data),
      onSubBatch: (prompts) => this.handleSubBatch(prompts),
    })

    try {
      await this.repl.initialize()
    } catch (err: any) {
      this.status = 'error'
      this.emit(IPC.RLM_ERROR, { error: `Failed to initialize REPL: ${err.message}` })
      return
    }

    // Snapshot tabs for diffing
    this.tabManager.captureSnapshot()

    let consecutiveNoCodes = 0
    const conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []

    try {
      for (let iteration = 0; iteration < maxIter; iteration++) {
        if (signal.aborted) {
          this.status = 'cancelled'
          this.emit(IPC.RLM_COMPLETE, { final: 'Task cancelled by user. Partial results may be available in the activity log.' })
          return
        }

        const iterStart = Date.now()
        this.emit(IPC.RLM_ITERATION_START, { iteration: iteration + 1, taskGoal: message })

        // Detect page changes since last iteration
        const pageChanges = this.tabManager.getChanges()
        if (pageChanges.length > 0) {
          this.emit(IPC.RLM_PAGE_CHANGES, { changes: pageChanges })
        }

        // Build context messages
        const contextMessages = await buildMessages(
          this.taskTracker,
          this.tabManager,
          this.repl,
          pageChanges
        )

        // Combine with conversation history for multi-turn
        const messages = [...conversationHistory, ...contextMessages]

        // Stream LLM response
        let fullResponse = ''
        try {
          fullResponse = await this.llmClient.streamCompletion(
            getSystemPrompt(),
            messages,
            this.config.primaryModel,
            (event) => {
              if (event.type === 'token' && event.token) {
                this.emit(IPC.RLM_STREAM_TOKEN, { token: event.token, iteration: iteration + 1 })
              }
            },
            signal
          )
        } catch (err: any) {
          if (signal.aborted) {
            this.status = 'cancelled'
            this.emit(IPC.RLM_COMPLETE, { final: 'Task cancelled by user.' })
            return
          }
          this.status = 'error'
          this.emit(IPC.RLM_ERROR, { error: `LLM error: ${err.message}` })
          return
        }

        if (signal.aborted) {
          this.status = 'cancelled'
          this.emit(IPC.RLM_COMPLETE, { final: 'Task cancelled by user.' })
          return
        }

        // Parse code blocks
        const codeBlocks = extractCodeBlocks(fullResponse)

        if (codeBlocks.length === 0) {
          consecutiveNoCodes++

          // Add assistant response + continuation to history
          conversationHistory.push(...contextMessages)
          conversationHistory.push({ role: 'assistant', content: fullResponse })
          conversationHistory.push({ role: 'user', content: getContinuationPrompt(iteration) })

          if (consecutiveNoCodes >= MAX_NO_CODE_CONTINUATIONS) {
            this.status = 'error'
            this.emit(IPC.RLM_ERROR, { error: 'Model failed to produce code after multiple attempts.' })
            return
          }

          // Record a no-code iteration
          const noCodeRecord: IterationRecord = {
            number: iteration + 1,
            blocks: [],
            timestamp: iterStart,
            durationMs: Date.now() - iterStart,
            oneLinerSummary: 'no code generated (continuation sent)',
            fullMetadata: `## Iteration ${iteration + 1}\nNo code blocks generated. Sent continuation prompt.`,
            pageChanges,
          }
          this.taskTracker.addIteration(noCodeRecord)
          continue
        }

        consecutiveNoCodes = 0

        // Execute ALL code blocks sequentially
        const blocks: BlockResult[] = []
        let finalCalled = false

        for (let bi = 0; bi < codeBlocks.length; bi++) {
          const code = codeBlocks[bi]
          this.emit(IPC.RLM_CODE_GENERATED, { code, blockIndex: bi })

          const result = await this.repl.execute(code)
          const metadata = this.summarize(code, result)
          const isError = result !== null && typeof result === 'object' && (result as any).__rlm_error

          blocks.push({ code, metadata, error: isError ? (result as any).message : undefined })
          this.emit(IPC.RLM_CODE_RESULT, { metadata, blockIndex: bi, error: isError ? (result as any).message : undefined })

          if (this.repl.isFinalCalled()) {
            finalCalled = true
            break
          }

          if (signal.aborted) break
        }

        // Emit env update
        if (this.repl) {
          const envMeta = await this.repl.getEnvMetadata()
          this.emit(IPC.RLM_ENV_UPDATE, { metadata: JSON.stringify(envMeta) })
        }

        // Build iteration record
        const fullMeta = blocks.map((b, i) => {
          const header = blocks.length > 1 ? `Block ${i + 1}:\n` : ''
          return `${header}${b.metadata}`
        }).join('\n\n')

        const oneLiner = this.summarizeIntent(blocks)

        const record: IterationRecord = {
          number: iteration + 1,
          blocks,
          timestamp: iterStart,
          durationMs: Date.now() - iterStart,
          oneLinerSummary: oneLiner,
          fullMetadata: `## Iteration ${iteration + 1} (${blocks.length} code block${blocks.length > 1 ? 's' : ''})\n${fullMeta}`,
          pageChanges,
        }
        this.taskTracker.addIteration(record)

        // Snapshot tabs for next diff
        this.tabManager.captureSnapshot()

        // Update conversation history
        conversationHistory.push(...contextMessages)
        conversationHistory.push({ role: 'assistant', content: fullResponse })

        // Check termination
        if (finalCalled) {
          this.status = 'complete'
          const finalVal = this.repl.getFinalValue()
          this.emit(IPC.RLM_COMPLETE, { final: finalVal })
          return
        }
      }

      // Hit iteration cap
      this.status = 'complete'
      this.emit(IPC.RLM_COMPLETE, {
        final: `Reached maximum iterations (${maxIter}). Partial results may be available in the activity log. Check REPL variables for intermediate data.`
      })
    } finally {
      // Cleanup
      if (this.repl) {
        this.repl.dispose()
        this.repl = null
      }
      this.abortController = null
    }
  }

  /** Handle a sub-LLM call from the REPL */
  private async handleSubCall(prompt: string, data?: unknown): Promise<string> {
    if (this.subCallCount >= (this.config.maxSubCalls || MAX_SUB_CALLS)) {
      return '[SUB-CALL ERROR] Maximum sub-call limit reached.'
    }
    this.subCallCount++

    this.emit(IPC.RLM_SUB_LLM_START, { prompt: prompt.slice(0, 200) })

    try {
      const subSystemPrompt = [
        getSystemPrompt(),
        '\n## Current Task Context',
        `User's request: "${this.taskTracker.getUserMessage()}"`,
        `Progress so far: ${this.taskTracker.progressSummary()}`,
        '\n## Your Sub-Task',
        prompt,
      ].join('\n')

      const messages = data
        ? [{ role: 'user' as const, content: `Data:\n${typeof data === 'string' ? data : JSON.stringify(data, null, 0)}\n\nExecute the sub-task described in your system prompt.` }]
        : [{ role: 'user' as const, content: 'Execute the sub-task described in your system prompt.' }]

      const result = await this.llmClient.complete(
        subSystemPrompt,
        messages,
        this.config.subModel || this.config.primaryModel,
        this.abortController?.signal
      )

      this.emit(IPC.RLM_SUB_LLM_COMPLETE, { resultMeta: `string (${result.length} chars)` })
      return result
    } catch (err: any) {
      const errMsg = `[SUB-CALL ERROR] ${err.message || String(err)}`
      this.emit(IPC.RLM_SUB_LLM_COMPLETE, { resultMeta: errMsg })
      return errMsg
    }
  }

  /** Handle batch sub-LLM calls */
  private async handleSubBatch(
    prompts: Array<{ prompt: string; data?: unknown }>
  ): Promise<Array<{ status: string; value?: string; error?: string }>> {
    const results = await Promise.allSettled(
      prompts.map(p => this.handleSubCall(p.prompt, p.data))
    )

    return results.map(r => {
      if (r.status === 'fulfilled') {
        return { status: 'fulfilled', value: r.value }
      }
      return { status: 'rejected', error: r.reason?.message || String(r.reason) }
    })
  }

  /** Generate rich metadata summary for a code execution result */
  private summarize(code: string, result: unknown): string {
    let summary = `Code:\n  ${code.split('\n').join('\n  ')}\n`

    if (result === undefined) {
      summary += 'Result: void'
    } else if (result === null) {
      summary += 'Result: null'
    } else if (typeof result === 'object' && (result as any).__rlm_error) {
      summary += `Result: ERROR — ${(result as any).message}`
      if ((result as any).stack) {
        summary += `\n  Stack: ${(result as any).stack.slice(0, 300)}`
      }
    } else if (typeof result === 'object' && (result as any).__truncated) {
      summary += `Result: TRUNCATED (original ${(result as any).originalLength} chars). Use a more specific selector to narrow results.`
      summary += `\nPreview: ${String((result as any).data).slice(0, PREVIEW_MAX_CHARS)}`
    } else if (Array.isArray(result)) {
      const str = JSON.stringify(result)
      const size = str?.length ?? 0
      const elemType = result.length > 0 ? this.describeType(result[0]) : 'empty'
      summary += `Result: Array<${elemType}> (${result.length} items, ${size} chars total)`
      if (result.length > 0 && typeof result[0] === 'object' && result[0] !== null) {
        summary += `\nElement schema: ${this.describeObjectSchema(result[0])}`
      }
      const preview = JSON.stringify(result.slice(0, 2), null, 0)
      summary += `\nPreview (first 2): ${preview?.slice(0, PREVIEW_MAX_CHARS) ?? ''}`
      if (result.length > 2) summary += `\n... and ${result.length - 2} more items`
    } else if (typeof result === 'object') {
      const str = JSON.stringify(result)
      const size = str?.length ?? 0
      const keys = Object.keys(result as object)
      summary += `Result: Object (${keys.length} keys, ${size} chars)`
      summary += `\nSchema: ${this.describeObjectSchema(result)}`
      summary += `\nPreview: ${str?.slice(0, PREVIEW_MAX_CHARS) ?? ''}${size > PREVIEW_MAX_CHARS ? '...' : ''}`
    } else if (typeof result === 'string' && result.length > 300) {
      summary += `Result: string (${result.length} chars)`
      summary += `\nPreview: "${result.slice(0, 250)}..."`
    } else {
      const str = JSON.stringify(result)
      summary += `Result: ${typeof result} = ${str?.slice(0, 300) ?? String(result)}`
    }

    return summary
  }

  /** Describe the schema of an object */
  private describeObjectSchema(obj: unknown): string {
    if (typeof obj !== 'object' || obj === null) return typeof obj
    if (Array.isArray(obj)) return `Array<${obj.length > 0 ? this.describeType(obj[0]) : 'unknown'}>`

    const fields = Object.entries(obj as Record<string, unknown>).map(([key, val]) => {
      const t = this.describeType(val)
      let preview = ''
      if (typeof val === 'string') preview = ` "${String(val).slice(0, 40)}${String(val).length > 40 ? '...' : ''}"`
      else if (typeof val === 'number' || typeof val === 'boolean') preview = ` ${val}`
      return `${key}: ${t}${preview}`
    })
    return `{ ${fields.join(', ')} }`
  }

  /** Concise type description */
  private describeType(val: unknown): string {
    if (val === null) return 'null'
    if (val === undefined) return 'undefined'
    if (Array.isArray(val)) return `Array<${val.length > 0 ? this.describeType(val[0]) : 'unknown'}>(${val.length})`
    if (typeof val === 'object') return `Object(${Object.keys(val as object).length} keys)`
    return typeof val
  }

  /** Summarize intent of code blocks for one-liner progress */
  private summarizeIntent(blocks: BlockResult[]): string {
    const parts: string[] = []
    for (const block of blocks) {
      // Extract key action from the code
      const code = block.code
      if (code.includes('setFinal')) parts.push('delivered final result')
      else if (code.includes('execInTab')) parts.push('queried tab DOM')
      else if (code.includes('openTab')) parts.push('opened new tab')
      else if (code.includes('navigate')) parts.push('navigated tab')
      else if (code.includes('click')) parts.push('clicked element')
      else if (code.includes('type(')) parts.push('typed into input')
      else if (code.includes('llm_query')) parts.push('sub-LLM call')
      else if (code.includes('llm_batch')) parts.push('batch sub-LLM calls')
      else if (code.includes('getText')) parts.push('extracted text')
      else if (code.includes('getLinks')) parts.push('extracted links')
      else if (code.includes('waitForLoad')) parts.push('waited for page load')
      else parts.push('executed code')

      // Append error info if present
      if (block.error) parts[parts.length - 1] += ` (ERROR: ${block.error.slice(0, 60)})`
    }
    return parts.join(', ')
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort()
    }
    this.status = 'cancelled'
  }

  resolveConfirmation(approved: boolean): void {
    if (this.pendingConfirmation) {
      this.pendingConfirmation(approved)
      this.pendingConfirmation = null
    }
  }

  getState(): TaskState {
    return {
      userMessage: this.taskTracker.getUserMessage(),
      iteration: this.taskTracker.getIterations().length,
      maxIterations: this.config.maxIterations || MAX_ITERATIONS,
      status: this.status,
      iterations: this.taskTracker.getIterations(),
    }
  }
}
