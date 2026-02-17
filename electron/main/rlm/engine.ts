import { WebContentsView, app } from 'electron'
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
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
  private traceFile: string | null = null

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
    this.trace(channel, data)
  }

  private trace(channel: string, data: unknown): void {
    if (!this.traceFile) return
    // Skip high-frequency token events to keep trace files readable
    if (channel === IPC.RLM_STREAM_TOKEN) return
    try {
      const line = JSON.stringify({ ts: Date.now(), ch: channel, data }) + '\n'
      appendFileSync(this.traceFile, line)
    } catch {
      // Best-effort — don't let trace logging break the engine
    }
  }

  private initTraceFile(message: string): void {
    try {
      const tracesDir = join(app.getPath('userData'), 'traces')
      mkdirSync(tracesDir, { recursive: true })
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const slug = message.slice(0, 40).replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+$/, '')
      this.traceFile = join(tracesDir, `${ts}_${slug}.jsonl`)
      writeFileSync(this.traceFile, JSON.stringify({ ts: Date.now(), event: 'run-start', message, config: { provider: this.config.provider, primaryModel: this.config.primaryModel, subModel: this.config.subModel, maxIterations: this.config.maxIterations } }) + '\n')
      console.log(`[RLM] Trace: ${this.traceFile}`)
    } catch {
      this.traceFile = null
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
    this.initTraceFile(message)

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
      this.emit(IPC.RLM_COMPLETE, { final: null })
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
          this.emit(IPC.RLM_COMPLETE, { final: null })
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
            this.emit(IPC.RLM_COMPLETE, { final: null })
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
          const metadata = this.summarize(code, result)       // full (code + result) for LLM history
          const resultMeta = this.summarizeResult(result)      // result-only for UI
          const isError = result !== null && typeof result === 'object' && (result as any).__rlm_error

          blocks.push({ code, metadata, error: isError ? (result as any).message : undefined })
          this.emit(IPC.RLM_CODE_RESULT, { metadata: resultMeta, blockIndex: bi, error: isError ? (result as any).message : undefined })

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
      this.traceFile = null
    }
  }

  /** Handle a sub-LLM call from the REPL — runs a full mini RLM loop */
  private async handleSubCall(prompt: string, data?: unknown): Promise<string> {
    if (this.subCallCount >= (this.config.maxSubCalls || MAX_SUB_CALLS)) {
      return '[SUB-CALL ERROR] Maximum sub-call limit reached.'
    }
    this.subCallCount++
    const subCallIndex = this.subCallCount - 1

    this.emit(IPC.RLM_SUB_LLM_START, { prompt: prompt.slice(0, 200), subCallIndex })

    const MAX_SUB_ITERATIONS = 10

    // Snapshot existing tab IDs so we can clean up any tabs the sub-agent creates
    const preExistingTabIds = new Set(this.tabManager.getAllTabs().map(t => t.id))

    // Create a fresh REPL for this sub-call with full access
    // Collect log messages so we can feed them back into the sub-agent's conversation
    const subLogs: string[] = []
    const subRepl = new REPLRuntime(this.tabManager, {
      onLog: (msg) => {
        this.emit(IPC.RLM_LOG, { message: `[sub-call] ${msg}` })
        subLogs.push(msg)
      },
      onSetFinal: (_value) => { /* checked via subRepl.isFinalCalled() */ },
      onSubCall: (_p, _d) => Promise.resolve('[SUB-CALL ERROR] Nested sub-calls not supported.'),
      onSubBatch: (_p) => Promise.resolve([{ status: 'rejected', error: 'Nested sub-calls not supported.' }]),
    })

    try {
      await subRepl.initialize()

      // Inject the data as a variable in the sub-REPL — no JSON.parse roundtrip
      if (data !== undefined) {
        await subRepl.execute(`var __data = (${JSON.stringify(data)})`)
      }

      // Same system prompt as main agent, just with llm_query/llm_batch excluded
      const basePrompt = getSystemPrompt({ isSubCall: true })
      const subSystemPrompt = [
        basePrompt,
        `\n## Sub-Task Context`,
        `User's original request: "${this.taskTracker.getUserMessage()}"`,
        `Progress so far: ${this.taskTracker.progressSummary()}`,
        `\n## Your Task`,
        prompt,
        data !== undefined ? `\n⚠️ IMPORTANT: The parent agent has loaded data into the variable \`__data\`. This is the content you need to process. Read it, reason about it, and call setFinal() with your answer. Do NOT open new tabs or search for the same information — the data is already in \`__data\`.` : '',
      ].join('\n')

      const history: Array<{ role: 'user' | 'assistant'; content: string }> = [
        { role: 'user', content: data !== undefined
          ? `Execute the sub-task. The data you need is already in \`__data\` — process it and call setFinal() with your answer. Do NOT open tabs or do searches.`
          : 'Execute the sub-task described in your system prompt.'
        },
      ]

      let consecutiveNoCodes = 0
      let llmErrors = 0

      for (let i = 0; i < MAX_SUB_ITERATIONS; i++) {
        if (this.abortController?.signal.aborted) {
          return '[SUB-CALL CANCELLED] Task cancelled by user.'
        }

        // Call LLM — resilient to transient failures, same as main loop
        let response: string
        try {
          response = await this.llmClient.complete(
            subSystemPrompt,
            history,
            this.config.subModel || this.config.primaryModel,
            this.abortController?.signal
          )
          llmErrors = 0
        } catch (err: any) {
          llmErrors++
          if (llmErrors >= 3) {
            // 3 consecutive LLM failures — genuinely broken, bail
            this.emit(IPC.RLM_SUB_LLM_COMPLETE, { resultMeta: `LLM failed 3 times: ${err.message}`, subCallIndex })
            return `[SUB-CALL ERROR] LLM failed 3 consecutive times: ${err.message}`
          }
          // Feed error into history and retry — same as main loop resilience
          history.push({ role: 'user', content: `LLM call error: ${err.message}. Retrying...` })
          continue
        }

        // Parse code blocks
        const codeBlocks = extractCodeBlocks(response)

        if (codeBlocks.length === 0) {
          consecutiveNoCodes++
          // Same continuation pattern as main loop
          history.push({ role: 'assistant', content: response })
          history.push({ role: 'user', content: getContinuationPrompt(i) })

          if (consecutiveNoCodes >= MAX_NO_CODE_CONTINUATIONS) {
            // Exhausted nudges — return the raw text as best-effort answer
            this.emit(IPC.RLM_SUB_LLM_COMPLETE, { resultMeta: `string (${response.length} chars) — no code after ${MAX_NO_CODE_CONTINUATIONS} attempts, returning raw text`, subCallIndex })
            return response
          }
          continue
        }

        consecutiveNoCodes = 0

        // Execute ALL code blocks sequentially — same as main loop
        const blockResults: Array<{ code: string; result: unknown }> = []
        for (const code of codeBlocks) {
          const result = await subRepl.execute(code)
          blockResults.push({ code, result })

          if (subRepl.isFinalCalled()) break
          if (this.abortController?.signal.aborted) break
        }

        if (subRepl.isFinalCalled()) {
          const finalVal = subRepl.getFinalValue()
          const result = typeof finalVal === 'string' ? finalVal : JSON.stringify(finalVal)
          this.emit(IPC.RLM_SUB_LLM_COMPLETE, { resultMeta: `string (${result.length} chars)`, subCallIndex })
          return result
        }

        // No setFinal — build per-block metadata and feed back, same as main loop
        const blockMeta = blockResults.map((b, idx) => {
          const prefix = blockResults.length > 1 ? `Block ${idx + 1}: ` : ''
          return `${prefix}${this.summarize(b.code, b.result)}`
        }).join('\n\n')

        // Include log output so the sub-agent can see what it logged
        let logSection = ''
        if (subLogs.length > 0) {
          let logText = subLogs.join('\n')
          if (logText.length > 8000) logText = logText.slice(0, 8000) + '\n... (truncated)'
          logSection = `\nLog output:\n${logText}`
          subLogs.length = 0
        }

        history.push({ role: 'assistant', content: response })

        const remainingIters = MAX_SUB_ITERATIONS - 1 - i
        let continueMsg: string
        if (remainingIters <= 2) {
          // Final iteration nudge — force the sub-agent to wrap up
          continueMsg = `Code executed.\n${blockMeta}${logSection}\n\n` +
            `🚨 CRITICAL: You have ${remainingIters} iteration${remainingIters !== 1 ? 's' : ''} remaining before this sub-task FAILS. ` +
            `STOP exploring, STOP logging data, STOP opening tabs. ` +
            `You MUST call setFinal() RIGHT NOW with the best answer you can give based on what you have already seen. ` +
            `Write a clean, natural language answer and call setFinal(answer) immediately.`
        } else if (data !== undefined) {
          continueMsg = `Code executed.\n${blockMeta}${logSection}\n\n⚠️ You have NOT called setFinal() yet. The data is in \`__data\`. Process it and call setFinal(value) NOW.`
        } else {
          continueMsg = `Code executed.\n${blockMeta}${logSection}\n\nContinue — call setFinal(value) when you have the result.`
        }
        history.push({ role: 'user', content: continueMsg })
      }

      // Hit iteration cap — return a clear error, not raw env metadata
      this.emit(IPC.RLM_SUB_LLM_COMPLETE, { resultMeta: `hit ${MAX_SUB_ITERATIONS} iterations without setFinal`, subCallIndex })
      return `[SUB-CALL ERROR] Sub-agent reached ${MAX_SUB_ITERATIONS} iterations without calling setFinal(). It may have gotten stuck. Try rephrasing or simplifying the sub-task.`
    } catch (err: any) {
      const errMsg = `[SUB-CALL ERROR] ${err.message || String(err)}`
      this.emit(IPC.RLM_SUB_LLM_COMPLETE, { resultMeta: errMsg, subCallIndex })
      return errMsg
    } finally {
      subRepl.dispose()

      // Auto-cleanup: close any tabs the sub-agent created
      const currentTabs = this.tabManager.getAllTabs()
      for (const tab of currentTabs) {
        if (!preExistingTabIds.has(tab.id)) {
          try {
            this.tabManager.closeTab(tab.id)
          } catch {
            // Tab may already be gone — ignore
          }
        }
      }
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

  /** Generate result-only summary (for UI display — code is shown separately) */
  private summarizeResult(result: unknown): string {
    if (result === undefined) {
      return 'void'
    } else if (result === null) {
      return 'null'
    } else if (typeof result === 'object' && (result as any).__rlm_error) {
      let s = `ERROR — ${(result as any).message}`
      if ((result as any).stack) s += `\n  Stack: ${(result as any).stack.slice(0, 300)}`
      return s
    } else if (typeof result === 'object' && (result as any).__truncated) {
      return `TRUNCATED (original ${(result as any).originalLength} chars). Use a more specific selector.\nPreview: ${String((result as any).data).slice(0, PREVIEW_MAX_CHARS)}`
    } else if (Array.isArray(result)) {
      const str = JSON.stringify(result)
      const size = str?.length ?? 0
      const elemType = result.length > 0 ? this.describeType(result[0]) : 'empty'
      let s = `Array<${elemType}> (${result.length} items, ${size} chars)`
      if (result.length > 0 && typeof result[0] === 'object' && result[0] !== null) {
        s += `\nSchema: ${this.describeObjectSchema(result[0])}`
      }
      const preview = JSON.stringify(result.slice(0, 2), null, 0)
      s += `\nPreview: ${preview?.slice(0, PREVIEW_MAX_CHARS) ?? ''}`
      if (result.length > 2) s += `\n... and ${result.length - 2} more`
      return s
    } else if (typeof result === 'object') {
      const str = JSON.stringify(result)
      const size = str?.length ?? 0
      const keys = Object.keys(result as object)
      let s = `Object (${keys.length} keys, ${size} chars)`
      s += `\nSchema: ${this.describeObjectSchema(result)}`
      s += `\nPreview: ${str?.slice(0, PREVIEW_MAX_CHARS) ?? ''}${size > PREVIEW_MAX_CHARS ? '...' : ''}`
      return s
    } else if (typeof result === 'string' && result.length > 300) {
      return `string (${result.length} chars)\nPreview: "${result.slice(0, 250)}..."`
    } else {
      const str = JSON.stringify(result)
      return `${typeof result} = ${str?.slice(0, 300) ?? String(result)}`
    }
  }

  /** Generate full metadata summary with code (for LLM history context) */
  private summarize(code: string, result: unknown): string {
    return `Code:\n  ${code.split('\n').join('\n  ')}\nResult: ${this.summarizeResult(result)}`
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
    // If the loop already exited (e.g. from an error), force-emit complete to reset the UI
    this.emit(IPC.RLM_COMPLETE, { final: 'Task cancelled by user.' })
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
