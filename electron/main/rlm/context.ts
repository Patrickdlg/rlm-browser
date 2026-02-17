import type { TabManager } from '../tabs/TabManager'
import type { REPLRuntime } from './repl'
import type { TaskTracker } from './task-tracker'
import type { TabChange } from '../../../src/shared/types'
import { compactHistory } from './history'
import { PREVIEW_MAX_CHARS, VAR_PREVIEW_MAX_CHARS } from './caps'

const SYSTEM_PROMPT = `You are an AI assistant operating inside a web browser called Ouroboros. You have programmatic access to all open tabs, their DOM, network requests, cookies, and storage.

You interact with the browser by writing JavaScript code in a REPL environment. Browser state is accessible through the API documented below. Your code runs in a sandboxed environment with async/await support.

## Rules
- Never request large data dumps. Use targeted selectors and queries.
- Store intermediate results on the \`env\` object (e.g. \`env.emails = [...]\`).
- Use \`llm_query(prompt, data?)\` for sub-tasks that process extracted data.
- Call \`setFinal(value)\` when you have the answer — this is the ONLY way to end the loop and deliver results to the user.
- Use \`log(message)\` to report progress visible to the user.
- Each iteration, you may write one or more code blocks. All will be executed sequentially.
- ALWAYS \`await\` async calls. Missing await will cause silent failures.
- \`sleep()\` is capped at 10 seconds. Prefer \`waitForLoad(tabId)\` for waiting on page loads.
- \`execInTab\` results are capped at 100K chars. Use specific selectors to narrow results.
- \`llm_query()\` may return "[SUB-CALL ERROR] ..." on failure — always check the result.

## REPL API Reference

### Tab Management
\`\`\`
tabs                          // Array<{id, url, title, status, favicon}> — live getter
activeTab                     // Current focused tab id — live getter
openTab(url?) → tabId         // Opens new tab, returns id
closeTab(tabId)               // Closes tab
navigate(tabId, url)          // Navigate existing tab
switchTab(tabId)              // Bring tab to focus
waitForLoad(tabId, timeout?)  // Wait until tab finishes loading (default 30s)
\`\`\`

### DOM Introspection
\`\`\`
execInTab(tabId, jsCode) → any              // Execute JS in tab's context, returns serialized result
getText(tabId, selector?) → string           // innerText of element (body if no selector)
getDOM(tabId, selector?) → string            // outerHTML of element
getLinks(tabId) → Array<{text, href}>        // All links on page
getInputs(tabId) → Array<{id, name, type, value, placeholder}>
querySelector(tabId, sel) → {tagName, id, className, innerText, href, src, value, type} | null
querySelectorAll(tabId, sel) → Array<{tagName, id, className, innerText, href, src}>
\`\`\`

### Browser Actions
\`\`\`
click(tabId, selector)              // Click an element
type(tabId, selector, text)         // Type into input field
scroll(tabId, direction, amount?)   // Scroll page ('up' or 'down', default 500px)
\`\`\`

### Recursive LLM Calls
\`\`\`
llm_query(prompt, data?) → string                    // Fresh LLM call with task context
llm_batch(prompts_array) → Array<{status, value?, error?}>  // Parallel batch (allSettled)
\`\`\`
Each prompt in llm_batch should be \`{prompt: string, data?: any}\` or just a string.

### REPL State & Output
\`\`\`
env.myVar = value              // Store variables on env object
setFinal(value)                // End loop, deliver result to user
log(message)                   // Log to user's activity panel
sleep(ms)                      // Async wait (CAPPED AT 10 SECONDS)
\`\`\`

## ⚠️ CRITICAL: Code Format ⚠️
You MUST wrap all executable code in \`\`\`repl blocks.
THIS IS THE ONLY WAY TO EXECUTE CODE.
Do NOT use \`\`\`js, \`\`\`javascript, or any other tag.
Do NOT describe code you would write — WRITE IT.
If you are planning, still write code. Planning without code wastes an iteration.

Example:
\`\`\`repl
const title = await execInTab(tabs[0].id, 'document.title')
log('Page title: ' + title)
\`\`\`
`

/** Build the full system prompt (constant) */
export function getSystemPrompt(): string {
  return SYSTEM_PROMPT
}

/** Build the continuation prompt when no code blocks found */
export function getContinuationPrompt(iteration: number): string {
  if (iteration === 0) {
    return 'You described your plan but did not write any code. Write the code now in a ```repl block to begin.'
  }
  return 'Continue — write code in a ```repl block to proceed with the task, or call setFinal(value) to deliver your response to the user.'
}

/** Build the environment metadata section */
export async function buildEnvMetadata(
  tabManager: TabManager,
  repl: REPLRuntime
): Promise<string> {
  const allTabs = tabManager.getAllTabs()
  const activeId = tabManager.getActiveTabId()

  const tabList = allTabs.map((t, i) =>
    `  [${i}] id:${t.id} | ${t.url} | "${t.title}" | ${t.status}`
  ).join('\n')

  const sessionInfo = allTabs
    .filter(t => t.url && !t.url.startsWith('about:'))
    .map(t => {
      try { return new URL(t.url).hostname } catch { return '' }
    })
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i) // unique

  // Get REPL variable metadata
  const envVars = await repl.getEnvMetadata()
  let varsSection = ''
  if (Object.keys(envVars).length > 0) {
    const varLines = Object.entries(envVars).map(([key, meta]: [string, any]) => {
      const preview = meta.preview ? ` — preview: ${String(meta.preview).slice(0, VAR_PREVIEW_MAX_CHARS)}` : ''
      if (meta.type?.startsWith('Array')) {
        const schema = meta.schema ? ` schema: {${meta.schema}}` : ''
        return `  ${key}: ${meta.type} (${meta.length} items, ${meta.size} chars)${schema}${preview}`
      } else if (meta.type === 'Object') {
        return `  ${key}: Object (${meta.keys} keys: ${meta.keyNames})${preview}`
      } else if (meta.type === 'string') {
        return `  ${key}: string (${meta.length} chars)${preview}`
      } else {
        return `  ${key}: ${meta.type} = ${meta.value || ''}`
      }
    })
    varsSection = `\n## REPL Variables\n${varLines.join('\n')}`
  }

  const lines = [
    `## Browser State`,
    `Open tabs (${allTabs.length}):`,
    tabList,
    `Active: ${activeId || 'none'}`,
  ]

  if (sessionInfo.length > 0) {
    lines.push(`Session active on: ${sessionInfo.join(', ')}`)
  }

  return lines.join('\n') + varsSection
}

/** Build page change notification section */
export function buildPageChanges(changes: TabChange[]): string {
  if (changes.length === 0) return ''

  const lines = ['## Page Changes Since Last Iteration']
  for (const c of changes) {
    lines.push(`  ${c.tabId}: ${c.field} changed from "${c.old}" to "${c.new}"`)
  }
  return lines.join('\n')
}

/** Assemble the full messages array for the LLM call */
export async function buildMessages(
  taskTracker: TaskTracker,
  tabManager: TabManager,
  repl: REPLRuntime,
  pageChanges: TabChange[]
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const sections: string[] = []

  // Task reinforcement (every iteration)
  sections.push(taskTracker.generateReinforcement())

  // Page change notifications
  const changeSection = buildPageChanges(pageChanges)
  if (changeSection) sections.push(changeSection)

  // Environment metadata
  const envMeta = await buildEnvMetadata(tabManager, repl)
  sections.push(envMeta)

  // Action history (compacted)
  const history = compactHistory(taskTracker.getIterations())
  if (history) sections.push(history)

  // Combine into a single user message for this iteration
  const content = sections.join('\n\n')

  return [{ role: 'user', content }]
}
