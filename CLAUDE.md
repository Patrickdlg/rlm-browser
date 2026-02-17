# CLAUDE.md — RLM Browser (codename: Ouroboros)

An Electron-based web browser where a Recursive Language Model engine has deep programmatic introspection into all browser state. The user gets a normal browsing experience PLUS a command center where they can instruct the LLM to operate across their tabs, sessions, and data — with full visibility into the RLM's reasoning, code execution, and outputs.

---

## 1. WHAT IS RLM (READ THIS FIRST)

RLM = Recursive Language Model (Zhang, Kraska, Khattab — MIT CSAIL, Jan 2026).

**The core insight:** The user's data (in our case, browser state) NEVER enters the LLM's context window directly. It lives as a variable in a persistent REPL environment. The LLM only sees constant-size metadata and interacts with the data by writing code.

### The Loop (Algorithm 1)

```
1. Initialize REPL with browser state accessible as variables
2. Capture user's original request as `taskGoal` (persists entire run)
3. LLM receives: system prompt + TASK REINFORCEMENT + environment METADATA + action history
4. LLM generates code (JavaScript)
5. If NO code blocks: send continuation prompt, go to step 3
6. Execute ALL code blocks in REPL → capture results
7. Append to history: the code + METADATA-ONLY summary of output (NOT raw stdout)
8. Diff environment state — flag any page changes (URL, title, load events) since last iteration
9. If `setFinal()` was called → return result to user, done
10. Else → go to step 3 (LLM generates next code block)
11. Hard cap at 25 iterations with safety bail — deliver partial results
```

**Task reinforcement (critical — LLMs drift after ~5 iterations):**
Every single iteration includes at the top of the context:
```
## Current Task
User's request: "Summarize my unread emails in Gmail"
Progress: Found 3 unread emails. Opened and extracted body of email 1. Currently summarizing.
Iteration: 4 of 25
```
This prevents the LLM from losing track of what it's supposed to be doing during long multi-step browser sessions. Without this, by iteration 8-10 it starts doing random tangential things.

### Three Pillars — Never Violate These

1. **Data as external variable.** Browser state (DOM, network, cookies, console, localStorage) is accessed via REPL API calls. The LLM context only holds a SHORT metadata summary of the environment. Example: `"Tab 0: gmail.com — Inbox (3 unread) — loaded"` not the entire Gmail DOM.

2. **Output through REPL state, not generation.** The final answer is returned by calling `setFinal(value)` in the REPL. This means output length is unbounded — the model builds up results in `env` variables across iterations, then delivers via `setFinal()`.

3. **Symbolic recursion.** Code in the REPL can call `llm_query(prompt, data?)` which spawns a FRESH LLM call with its own clean context window. Because these are code-invoked (not verbalized), the model can write loops that spawn Ω(n) sub-calls. Each sub-call gets only the data slice it needs.

### What NOT to Do (Algorithm 2 — The Wrong Way)

Do NOT stuff browser content (page HTML, large text, etc.) into the LLM's context window. That inherits context window limits and causes degradation. The whole point is that the LLM writes code to access what it needs surgically.

### Metadata-Only History Append

After each REPL execution, do NOT append raw stdout to the LLM's history. Instead append a metadata summary:
- Code that was executed (verbatim)
- Result type and size: `"Returned: string (2,847 chars), stored in var 'emailBodies'"`
- First ~200 chars of output as preview (truncated)
- Any errors

This forces the model to store intermediate results in REPL variables and use sub-calls, instead of polluting its own context.

---

## 2. ARCHITECTURE OVERVIEW

```
┌─────────────────────────────────────────────────────┐
│                   Electron App                       │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │              Main Process (Node.js)           │   │
│  │                                               │   │
│  │  ┌─────────────┐  ┌──────────────────────┐   │   │
│  │  │  Tab Manager │  │    RLM Engine         │   │   │
│  │  │  (WebContents │  │  ┌────────────────┐  │   │   │
│  │  │   View mgmt) │  │  │  REPL Runtime   │  │   │   │
│  │  │              │  │  │  (VM / eval)    │  │   │   │
│  │  │              │  │  ├────────────────┤  │   │   │
│  │  │              │  │  │  Context Builder│  │   │   │
│  │  │              │  │  │  (metadata gen) │  │   │   │
│  │  │              │  │  ├────────────────┤  │   │   │
│  │  │              │  │  │  LLM Client     │  │   │   │
│  │  │              │  │  │  (Anthropic API)│  │   │   │
│  │  │              │  │  ├────────────────┤  │   │   │
│  │  │              │  │  │  Loop Controller│  │   │   │
│  │  │              │  │  │  (Algo 1 impl) │  │   │   │
│  │  │              │  │  └────────────────┘  │   │   │
│  │  └─────────────┘  └──────────────────────┘   │   │
│  │                                               │   │
│  │  IPC Bridge (main ↔ renderer)                 │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌─────────────┐  ┌─────────┐  ┌─────────┐         │
│  │ Command      │  │ Tab 1   │  │ Tab 2   │  ...    │
│  │ Center       │  │ (WCV)   │  │ (WCV)   │         │
│  │ (WCV - React)│  │ gmail   │  │ github  │         │
│  └─────────────┘  └─────────┘  └─────────┘         │
│                                                      │
│  WCV = WebContentsView                               │
└─────────────────────────────────────────────────────┘
```

### Key Decisions

- **Electron** — wraps Chromium. We're not writing a browser engine. Electron gives us `WebContentsView` for multi-tab, `webContents.executeJavaScript()` for code injection, `webContents.debugger` for CDP, session/cookie access, network interception, and full Node.js in the main process.
- **WebContentsView IS a real browser tab.** Each one runs a full Chromium renderer process. JavaScript, cookies, localStorage, sessions, WebGL, service workers — all of it works identically to a regular Chrome tab. Users can log into Twitter, Gmail, their bank — everything works. By default, all WebContentsViews share the app's session (so cookies and logins persist across tabs), but they can also be given isolated sessions if needed.
- **Main process owns the RLM engine.** The REPL, loop controller, LLM client, and context builder all live in the main process (Node.js). They have direct access to all `webContents` instances.
- **Command Center is a WebContentsView** — a React app that serves as the user's interface to the RLM. Shows chat, activity log, code execution trace, and outputs. Communicates with main process via IPC.
- **User tabs are standard WebContentsViews** — the user browses normally. The RLM can introspect and act on any tab via the REPL API.

---

## 3. REPL API SURFACE

The REPL is a sandboxed JavaScript execution environment in the main process. The LLM's generated code runs here. It has access to the following API:

### 3.1 Tab Management

```js
tabs                          // Array<{id, url, title, status, favicon}> — live updated
activeTab                     // Current focused tab id

openTab(url) → tabId          // Opens new tab, returns id
closeTab(tabId)               // Closes tab
navigate(tabId, url)          // Navigate existing tab
switchTab(tabId)              // Bring tab to focus
waitForLoad(tabId, timeout?)  // Wait until tab finishes loading
```

### 3.2 DOM Introspection (THE CORE — this is how the LLM reads pages)

```js
// Execute arbitrary JS in a tab's renderer context and return result
execInTab(tabId, jsCode) → serializedResult

// Convenience wrappers (implemented via execInTab internally):
getDOM(tabId, selector?) → string           // Serialized HTML of element(s)
getText(tabId, selector?) → string          // innerText extraction
getLinks(tabId) → Array<{text, href}>       // All links on page
getInputs(tabId) → Array<{id, name, type, value}>  // Form state
querySelector(tabId, sel) → elementInfo     // Single element metadata
querySelectorAll(tabId, sel) → elementInfo[] // Multiple elements

// Accessibility tree (like what browser agents use — structured, compact)
getAccessibilityTree(tabId) → object

// Screenshot for vision model sub-calls
screenshot(tabId, rect?) → base64png
```

### 3.3 Browser Actions (how the LLM acts on pages)

```js
click(tabId, selector)                   // Click an element
type(tabId, selector, text)              // Type into input
fill(tabId, formData)                    // Fill form: {selector: value, ...}
scroll(tabId, direction, amount?)        // Scroll page
keyPress(tabId, key, modifiers?)         // Keyboard event
hover(tabId, selector)                   // Mouse hover
select(tabId, selector, value)           // Select dropdown option
```

### 3.4 Session & Storage

```js
getCookies(tabId?, filter?) → Cookie[]         // Get cookies
setCookie(cookie)                               // Set a cookie
getLocalStorage(tabId, key?) → object           // Read localStorage
getSessionStorage(tabId, key?) → object         // Read sessionStorage
clearStorage(tabId, type?)                      // Clear storage
```

### 3.5 Network Introspection

```js
getRecentRequests(tabId, filter?) → Request[]   // Recent XHR/fetch
interceptRequests(tabId, pattern, handler)       // Intercept matching requests
getResponseBody(requestId) → string|Buffer       // Get response body of captured request
```

### 3.6 Console & Errors

```js
getConsoleLog(tabId, filter?) → LogEntry[]      // Console messages
getErrors(tabId) → Error[]                       // JS errors on page
```

### 3.7 Recursive LLM Calls

```js
// Spawn a fresh LLM call with its own context window.
// The sub-call automatically receives: the main system prompt + a task summary
// ("You are helping with: [user's original request]. Parent progress: [summary].")
// plus the focused sub-prompt and optional data.
// DO NOT send naked prompts — sub-agents need identity and context to function.
llm_query(prompt, data?) → string

// Parallel batch version — uses Promise.allSettled internally.
// Returns array of {status, value, error} for each item.
// One failure does NOT kill the batch.
llm_batch(prompts_array) → Array<{status: 'fulfilled'|'rejected', value?: string, error?: string}>
```

**Sub-agent context assembly (critical — learned from production):**
```ts
async function subCall(prompt: string, data?: any): Promise<string> {
  try {
    const subSystemPrompt = [
      mainSystemPrompt,                    // Full identity + API reference
      `\n## Current Task Context`,
      `User's request: "${currentTask.userMessage}"`,
      `Progress so far: ${currentTask.progressSummary()}`,
      `\n## Your Sub-Task`,
      prompt
    ].join('\n');

    const messages = data
      ? [{ role: 'user', content: `Data:\n${typeof data === 'string' ? data : JSON.stringify(data, null, 0)}\n\nExecute the sub-task described in your system prompt.` }]
      : [{ role: 'user', content: 'Execute the sub-task described in your system prompt.' }];

    const response = await anthropic.messages.create({
      model: config.subModel || currentModel,  // Use sub-model for cost control
      system: subSystemPrompt,
      messages,
      max_tokens: 4096,
      temperature: 0
    });
    
    return response.content[0].text;
  } catch (err) {
    // NEVER throw from sub-calls — return error string so REPL code can handle it
    return `[SUB-CALL ERROR] ${err.message || String(err)}`;
  }
}
```

**Why this matters:** Without the system prompt and task context, sub-agents don't know who they are, what APIs are available, or what the broader task is. They produce confused, low-quality results. Every sub-call gets the full system prompt.

### 3.8 REPL State & Output

```js
// All user variables should be stored on the env object — this prevents
// namespace collisions with the REPL API and makes metadata generation trivial
// (just enumerate env keys).
env.results = []
env.results.push(newItem)
env.emailBodies = [...]

// End the loop and return result to user. Use setFinal() — NOT a FINAL variable.
// setFinal() immediately signals the loop controller (no polling needed)
// and avoids accidental termination from page data containing a "FINAL" key.
setFinal("Here are your summarized emails: ...")

// For large results, pass the value directly — no indirection via variable names
setFinal(env.results)
```

**Why `setFinal()` instead of `FINAL = value`:**
- Avoids accidental termination if extracted page data has a field named "FINAL"
- Gives an immediate signal to the loop controller (function call hook vs polling state)
- No `FINAL_VAR` indirection needed — just pass the value directly, even if it's large

### 3.9 Utilities

```js
log(message)                    // Log to activity feed (visible in Command Center)
sleep(ms)                       // Async wait — CAPPED AT 10 SECONDS (10000ms)
store(key, value)               // Persistent key-value store across runs
retrieve(key) → value           // Retrieve from persistent store
```

**`sleep()` is capped at 10 seconds.** The LLM will write `await sleep(60000)` if you let it. System prompt must say: "sleep() is capped at 10s. Prefer `waitForLoad(tabId)` for waiting on page loads."

### 3.10 Size Limits (critical for stability)

`execInTab` return values are **capped at 100,000 characters**. If the serialized result exceeds this:
- Truncate to 100k chars
- Append to the REPL variable as `{ __truncated: true, length: originalLength, data: truncatedData }`
- The metadata summary says: `"Result truncated (was 2.3MB). Use a more specific selector to narrow results."`

This prevents a naive `getDOM(tabId)` on Gmail from dumping megabytes into a REPL variable. The metadata summary previews are already bounded (400 chars), but the underlying variable needs a cap too.

Similarly, `getText(tabId)` without a selector on a large page will return huge strings. The same 100k cap applies.

```ts
function capResult(result: any, maxChars: number = 100000): any {
  const serialized = JSON.stringify(result);
  if (serialized && serialized.length > maxChars) {
    return {
      __truncated: true,
      originalLength: serialized.length,
      data: typeof result === 'string' 
        ? result.slice(0, maxChars) 
        : JSON.parse(serialized.slice(0, maxChars) + '...')  // best effort
    };
  }
  return result;
}
```

---

## 4. CONTEXT BUILDER

The context builder constructs what the LLM actually sees each iteration. This is CRITICAL to get right.

### System Prompt (constant, ~3-4k tokens)
The system prompt includes the full API reference with return types. This is bigger than originally estimated — ~30 functions with type signatures and return schemas need ~2-3k tokens alone. Budget accordingly.

```
You are an AI assistant operating inside a web browser. You have programmatic
access to all open tabs, their DOM, network requests, cookies, and storage.

You interact with the browser by writing JavaScript code in a REPL.
Browser state is accessible through the API documented below.

RULES:
- Never request large data dumps. Use targeted selectors and queries.
- Store intermediate results on the env object (e.g. env.emails = [...]).
- Use llm_query() for sub-tasks that process extracted data.
- Call setFinal(value) when you have the answer — this is the ONLY way to end the loop.
- Use log() to report progress to the user.
- Each iteration, you may write one or more code blocks. All will be executed
  sequentially and you'll see a metadata summary of the results.
- If you need to think/plan, still include at least one code block to proceed.
- ALWAYS await async calls. Missing await will cause silent failures.

[REPL API REFERENCE — including return type schemas for every function]

Example return types (include these for ALL API functions):
  execInTab(tabId, code) → any (serialized JSON — DOM nodes become strings)
  getLinks(tabId) → Array<{ text: string, href: string }>
  getInputs(tabId) → Array<{ id: string, name: string, type: string, value: string, placeholder: string }>
  getAccessibilityTree(tabId) → { role: string, name: string, children: AccessNode[], ... }
  getRecentRequests(tabId, filter?) → Array<{ url: string, method: string, status: number, type: string, size: number }>
  getCookies(tabId?) → Array<{ name: string, value: string, domain: string, path: string, expires: number }>
  screenshot(tabId) → string (base64 PNG data URI)
  llm_query(prompt, data?) → string (may return "[SUB-CALL ERROR] ..." on failure — always check)
  llm_batch(prompts) → Array<{ status: 'fulfilled'|'rejected', value?: string, error?: string }>
  ... etc for all functions
```

### Task Reinforcement (dynamic, ~200-400 tokens, EVERY iteration)
This prevents goal drift. Generated fresh each iteration:
```
## Current Task
User's request: "Summarize my unread emails in Gmail"
Iteration: 4 of 25
Progress so far:
  - Iter 1: queried unread count → 3
  - Iter 2: extracted email subjects (Array<string>, 3 items)
  - Iter 3: opened email 1, extracted body (2,341 chars)
  - Iter 4: sub-LLM summarized email 1 (89 chars)
```

**Progress is auto-generated from iteration metadata, NOT from `log()` calls.** If you depend on the LLM calling `log()`, and it doesn't, you get an empty progress section and goal drift kicks in at iteration 5. Instead, mechanically derive progress from the code descriptions and result summaries you already have:

```ts
function generateProgress(iterations: IterationRecord[]): string {
  return iterations.map(iter => {
    const action = summarizeCodeIntent(iter.code);     // "queried unread count"
    const result = iter.resultOneLiner;                 // "→ 3" or "→ Array<string> (3 items)"
    return `  - Iter ${iter.number}: ${action} ${result}`;
  }).join('\n');
}
```

`log()` calls still show in the activity panel for the user, but the task reinforcement doesn't depend on them.

### Page Change Notifications (dynamic, when applicable)
Between iterations, detect and report changes the LLM didn't cause:
```
## Page Changes Since Last Iteration
  tab_a: URL changed from gmail.com/inbox to gmail.com/mail/u/0/#inbox/FMfcgz...
  tab_a: Title changed from "Inbox (3) - Gmail" to "Meeting tomorrow - Gmail"
  tab_b: New console error: "Uncaught TypeError: Cannot read property..."
```

Implementation: snapshot each tab's {url, title, loadStatus} before and after each iteration. Diff them. Include the diff in the next iteration's context only if changes occurred. This prevents the LLM from trying old selectors on pages that navigated.

### Environment Metadata (dynamic, target ~2-4k tokens)
Generated fresh each iteration. Variable descriptions must include full structural info — keys, types, shapes — so the LLM can navigate the state confidently:
```
## Browser State
Open tabs (3):
  [0] id:tab_a | gmail.com/inbox | "Inbox (3) - Gmail" | loaded
  [1] id:tab_b | github.com/dfusion-ai/repo | "dfusion-ai/repo" | loaded  
  [2] id:tab_c | docs.google.com/d/xxx | "Q4 Planning Doc" | loaded
Active: tab_a
Session: logged into google.com, github.com

## REPL Variables
  emailCount: number = 47
  unreadEmails: Array<Object> (3 items, 487 chars)
    schema: { subject: string, sender: string, snippet: string, timestamp: string }
  currentDraft: string (1,204 chars) — preview: "Hi team, following up on..."
  priceData: Object (4 keys: flights, hotels, total, currency)
    flights: Array<Object>(12) schema: { airline: string, price: number, departure: string }
    hotels: Array<Object>(8) schema: { name: string, rate: number, stars: number }
    total: number = 1847.50
    currency: string = "USD"
  
## Persistent Store Keys
  ["user_preferences", "last_run_summary"]
```

The variable metadata is generated using the same `describeObjectSchema()` and `describeType()` functions from the metadata summary generator. This is essential — without structural metadata, the LLM has to guess at object shapes and makes type errors.

### Action History (grows, metadata-only)
```
## Iteration 1
Code:
  const count = await execInTab('tab_a', 'document.querySelectorAll(".zA.zE").length')
  log(`Found ${count} unread emails`)
Result: number = 3. Log: "Found 3 unread emails"

## Iteration 2  
Code:
  const subjects = await execInTab('tab_a', `
    [...document.querySelectorAll(".zA.zE .bog span")].map(e => e.innerText)
  `)
Result: Array<string> (3 items, 127 chars). Stored in var 'subjects'.
Preview (first 2): ["Meeting tomorrow at 3pm", "Invoice #4521"]
... and 1 more items

## Iteration 3
Code:
  const emailDetails = await execInTab('tab_a', `
    [...document.querySelectorAll('.zA.zE')].map(el => ({
      subject: el.querySelector('.bog span')?.innerText,
      sender: el.querySelector('.yW span')?.getAttribute('name'),
      snippet: el.querySelector('.y2')?.innerText
    }))
  `)
Result: Array<Object(3 keys: subject, sender, snippet)> (3 items, 487 chars)
Element schema: { subject: string "Meeting tomorrow at 3pm", sender: string "Alice Chen", snippet: string "Hi, just wanted to confirm..." }
Preview (first 2): [{"subject":"Meeting tomorrow at 3pm","sender":"Alice Chen","snippet":"Hi, just wanted to confirm our meeting..."},{"subject":"Invoice #4521","sender":"Billing Dept","snippet":"Your invoice is ready..."}]
... and 1 more items
```

### History Management Strategy
History grows with each iteration. **Use adaptive token-based compaction, NOT fixed iteration thresholds** — a single iteration with a 2000-token code block can blow the budget at iteration 4.

```ts
function compactHistory(iterations: IterationRecord[], tokenBudget: number): string {
  const fullHistory = iterations.map(i => i.fullMetadata);
  const currentTokens = estimateTokens(fullHistory.join('\n'));
  
  if (currentTokens <= tokenBudget) {
    // Everything fits — no compaction needed
    return fullHistory.join('\n\n');
  }
  
  // Keep the last 3 iterations at full detail always
  const recentCount = Math.min(3, iterations.length);
  const recent = iterations.slice(-recentCount);
  const older = iterations.slice(0, -recentCount);
  
  // Summarize all older iterations into one condensed paragraph
  const condensed = older.map(i => 
    `Iter ${i.number}: ${i.oneLinerSummary}`  // e.g. "queried unread count → 3"
  ).join('. ');
  
  const summary = `## Earlier iterations (condensed)\n${condensed}`;
  const recentFull = recent.map(i => i.fullMetadata).join('\n\n');
  
  return `${summary}\n\n${recentFull}`;
}

// Before each LLM call:
const historyStr = compactHistory(iterations, TOKEN_BUDGET_HISTORY);
```

The key insight: compaction triggers based on **actual token count exceeding 80% of the history budget**, not based on iteration number. A run with small iterations might never need compaction. A run with huge DOM extractions might compact at iteration 3.

### Token Budget (realistic)
Target total context per iteration: **~12-16k tokens**
- System prompt + API reference: ~3500 fixed
- Task reinforcement: ~300 dynamic
- Page change notifications: ~200 when present
- Environment metadata: ~2000-4000 dynamic
- History: ~4000-8000 depending on iteration count

This fits comfortably in any modern model's context window and leaves plenty of room for the LLM's response.

---

## 5. COMMAND CENTER UI

The Command Center is the user-facing interface to the RLM. It's a React app rendered in its own WebContentsView, always accessible (sidebar, bottom panel, or overlay — user's choice).

### 5.1 Layout

```
┌──────────────────────────────────────────────┐
│  [Chat Input]                                 │
│  ┌─────────────────────┬────────────────────┐ │
│  │                     │                    │ │
│  │   Conversation      │   Activity Panel   │ │
│  │   (user ↔ RLM)      │                    │ │
│  │                     │   - Code executed   │ │
│  │   Shows final       │   - Tab actions     │ │
│  │   outputs, asks     │   - Network calls   │ │
│  │   for clarification │   - Sub-LLM calls   │ │
│  │                     │   - Errors           │ │
│  │                     │   - Progress logs    │ │
│  │                     │                    │ │
│  ├─────────────────────┴────────────────────┤ │
│  │  Output Panel (expandable)                │ │
│  │  - Tables, summaries, files               │ │
│  │  - Persistent across runs                 │ │
│  └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

### 5.2 Activity Panel — Real-Time RLM Visibility

The activity panel shows the RLM loop in real time:

```
▶ Iteration 1                              [0.3s]
  📝 Code: execInTab('tab_a', '...')
  ✅ Result: number = 3

▶ Iteration 2                              [0.8s]  
  📝 Code: const subjects = await execInTab(...)
  ✅ Result: string[] (3 items)

▶ Iteration 3                              [2.1s]
  📝 Code: llm_query("Summarize this email", emailBody)
  🔄 Sub-LLM call spawned
  ✅ Sub-result: string (245 chars)

▶ Iteration 4                              [0.1s]
  📝 Code: setFinal(summaryText)
  🏁 Done — result delivered
```

Each iteration is expandable to show full code and full output.

### 5.3 IPC Messages (Command Center ↔ Main Process)

```
// Renderer → Main
rlm:submit-task        {message: string}        // User submits a task
rlm:cancel             {}                        // User cancels current run (triggers AbortController)
rlm:get-state          {}                        // Request current env state
rlm:confirmation-resp  {approved: boolean}       // User approves/denies sensitive action

// Main → Renderer  
rlm:iteration-start    {iteration: number, taskGoal: string}
rlm:stream-token       {token: string, iteration: number}     // Real-time LLM token streaming
rlm:code-generated     {code: string, blockIndex: number}     // Per-block
rlm:code-result        {metadata: object, blockIndex: number} // Per-block result        
rlm:sub-llm-start      {prompt: string}          
rlm:sub-llm-complete   {resultMeta: object}      
rlm:page-changes       {changes: Array<{tabId, field, old, new}>}  // Page diffs between iterations
rlm:log                {message: string}         
rlm:error              {error: string}           
rlm:complete           {final: string|object}    
rlm:env-update         {metadata: object}        // Updated env state
rlm:confirmation-req   {action: string, details: object}  // Sensitive action approval
```

---

## 6. IMPLEMENTATION PLAN

### Phase 1: Skeleton Electron Browser
**Goal:** A working browser with tabs. No RLM yet.

- Electron app with `BaseWindow` + `WebContentsView` multi-tab setup
- Tab bar UI (open, close, switch, navigate)
- Address bar with URL input
- Back/forward/refresh controls
- Command Center panel placeholder (empty for now)
- Basic tab state management in main process

**Tech:** Electron v33+, React 19 for chrome UI, TypeScript

### Phase 2: REPL Runtime
**Goal:** The code execution engine that the RLM will use.

- **isolated-vm** sandbox setup with message-passing API surface (NOT Node's vm)
- REPL API implementation — all functions from Section 3 exposed as isolate references
  - Start with: `execInTab`, `tabs`, `getDOM`, `getText`, `click`, `type`, `navigate`
  - Then: `getCookies`, `getLocalStorage`, `getRecentRequests`
  - Then: `screenshot`, `getAccessibilityTree`
- Variable persistence across iterations within a run
- `setFinal()` detection (the ONLY loop termination signal)
- Error handling: try/catch per execution, errors returned as metadata (not thrown)
- Global `unhandledRejection` handler as safety net for missing `await`
- `log()` function that sends IPC to Command Center
- Timeout per execution (30s default)

### Phase 3: LLM Client + Loop Controller
**Goal:** The RLM loop from the paper, wired to real LLM.

- Anthropic API client (Claude Sonnet 4 for speed, option for Opus for complex tasks)
- Context builder with ALL sections:
  - System prompt with full API reference including return type schemas
  - Task reinforcement (user's goal + progress summary) — refreshed every iteration
  - Page change notifications (URL/title diff between iterations)
  - Environment metadata (tab list + rich variable schemas)
  - Action history with metadata-only summaries
- History management: sliding window with compressed prefix (see Section 4)
- Loop controller implementing Algorithm 1:
  - No code blocks → continuation prompt, NOT termination
  - Multiple code blocks per response → execute all sequentially, one metadata summary
  - FINAL/FINAL_VAR → replaced by setFinal(value) — terminate and deliver
  - Iteration cap (default 25) → deliver partial results
- `llm_query()` implementation — sub-calls get full system prompt + task context + sub-prompt
- `llm_query()` wrapper with try/catch — errors return strings, never throw
- `llm_batch()` — uses `Promise.allSettled`, returns per-item status/value/error
- Sub-calls are data-processing only — no browser access from sub-agents

### Phase 4: Command Center UI
**Goal:** The user interface for interacting with the RLM.

- Chat interface (user messages + RLM responses)
- Activity panel with **real-time token streaming** — show LLM output as it generates
- Per-block code + result display with syntax highlighting
- Expandable iteration details
- Output panel for structured results
- Cancel button wired to AbortController
- Settings: API key input, primary model + sub-model selection, iteration cap

### Phase 5: Polish & Advanced Features
- Persistent store (IndexedDB backed) for cross-run memory
- Task templates / saved prompts
- History of past runs with replay
- Multi-model support (switch between Claude, GPT, local models)
- Security: CSP policies, sandboxing review, permission prompts for sensitive actions
- Optional: record RLM sessions as shareable traces

---

## 7. FILE STRUCTURE

```
ouroboros/
├── package.json
├── tsconfig.json
├── electron-builder.yml
├── CLAUDE.md                          ← this file
│
├── src/
│   ├── main/                          # Electron main process
│   │   ├── index.ts                   # App entry, window creation
│   │   ├── tabs/
│   │   │   ├── TabManager.ts          # WebContentsView lifecycle
│   │   │   ├── TabState.ts            # Tab metadata tracking
│   │   │   └── TabDiffer.ts           # Detect page changes between iterations
│   │   │
│   │   ├── rlm/
│   │   │   ├── engine.ts              # Loop controller (Algorithm 1) + AbortController
│   │   │   ├── repl.ts                # REPL runtime + API surface (isolated-vm)
│   │   │   ├── context.ts             # Context builder (metadata generation)
│   │   │   ├── task-tracker.ts        # Task reinforcement — goal + progress per iteration
│   │   │   ├── llm-client.ts          # Anthropic API client + streaming + sub-call wrapper
│   │   │   ├── history.ts             # Iteration history with token-based adaptive compaction
│   │   │   ├── parser.ts              # Code block extraction with fallback chain
│   │   │   └── caps.ts               # Result size limits, sleep caps, timeout management
│   │   │
│   │   ├── ipc/
│   │   │   └── handlers.ts            # IPC message handlers
│   │   │
│   │   └── store/
│   │       └── persistent.ts          # IndexedDB-backed persistent k/v store
│   │
│   ├── renderer/                      # React apps for UI
│   │   ├── chrome/                    # Browser chrome (tab bar, address bar, controls)
│   │   │   ├── App.tsx
│   │   │   ├── TabBar.tsx
│   │   │   ├── AddressBar.tsx
│   │   │   └── NavigationControls.tsx
│   │   │
│   │   └── command-center/            # Command Center panel
│   │       ├── App.tsx
│   │       ├── Chat.tsx               # Conversation view
│   │       ├── ActivityPanel.tsx       # Real-time iteration display
│   │       ├── OutputPanel.tsx         # Structured outputs
│   │       ├── IterationCard.tsx       # Single iteration expandable view
│   │       └── Settings.tsx           # API key, model, preferences
│   │
│   ├── preload/
│   │   ├── chrome.ts                  # Preload for browser chrome
│   │   └── command-center.ts          # Preload for command center
│   │
│   └── shared/
│       ├── types.ts                   # Shared TypeScript types
│       └── ipc-channels.ts            # IPC channel name constants
│
├── static/
│   └── icons/                         # App icons
│
└── tests/
    ├── repl.test.ts                   # REPL API tests
    ├── context.test.ts                # Context builder tests
    └── engine.test.ts                 # Loop controller tests
```

---

## 8. CRITICAL IMPLEMENTATION NOTES

### execInTab is the Foundation
Almost everything the RLM does flows through `execInTab(tabId, jsCode)`. This calls `webContents.executeJavaScript(code)` on the target tab. The code runs in the renderer context of that tab — full DOM access, fetch API, everything. Results are serialized back via IPC.

**IMPORTANT:** `executeJavaScript` returns a Promise of the serialized result. Complex objects (DOM nodes) can't be returned directly — the REPL API wrappers must serialize to JSON-safe representations.

### Sandboxing the REPL — Use isolated-vm, NOT Node's vm module
The REPL code runs LLM-generated JavaScript that has access to `executeJavaScript` on real browser tabs (Gmail, banks, etc.). This is a real security boundary. **Node's `vm` module is NOT a sandbox** — it's trivially escapable. Use `isolated-vm` which runs code in a separate V8 isolate with no access to the host process.

The REPL API must be exposed via message-passing across the isolation boundary — the LLM's code calls stub functions that send messages to the host, the host executes the real implementation, and returns the result.

```ts
import ivm from 'isolated-vm';

const isolate = new ivm.Isolate({ memoryLimit: 128 }); // 128MB limit
const context = await isolate.createContext();

// Expose REPL API as references that call back into the host process
const jail = context.global;

// Each API function is a Reference that the isolate calls out to
await jail.set('_execInTab', new ivm.Reference(async (tabId: string, code: string) => {
  return tabManager.exec(tabId, code);
}));

// In the isolate, wrap the reference into a callable function:
await context.eval(`
  async function execInTab(tabId, code) {
    return _execInTab.apply(undefined, [tabId, code], { result: { promise: true } });
  }
`);

// Similar pattern for all REPL API functions...
// The isolate ONLY has access to the explicitly exposed API stubs.
// No require, no process, no fs, no net, no Buffer — nothing from Node.
```

The explicit allowlist of what the REPL can do:
- Tab management functions (openTab, closeTab, navigate, etc.)
- DOM introspection (execInTab, getDOM, getText, etc.)
- Browser actions (click, type, fill, etc.)
- Session/storage read access
- Network introspection (read-only)
- llm_query / llm_batch
- log, sleep (capped at 10 seconds — see below), store, retrieve
- `env` object for user variable storage (prevents namespace collisions with API)
- `setFinal(value)` output function
- Standard JS builtins: JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, Promise

Nothing else. No file system, no network, no child processes, no eval of arbitrary Node code.

### Async REPL Execution
LLM-generated code will almost always be async (since execInTab, llm_query, etc. return Promises). Execute in the isolate with async support:

```ts
async function executeREPL(code: string, context: ivm.Context): Promise<any> {
  const wrappedCode = `(async () => { ${code} })()`;
  try {
    const result = await context.eval(wrappedCode, { 
      timeout: 30000,       // 30s hard timeout per execution
      promise: true          // Allow async/await
    });
    return result;
  } catch (err) {
    // Return error info so the LLM can see it and self-correct
    return { __rlm_error: true, message: err.message, stack: err.stack?.slice(0, 500) };
  }
}
```

**Global safety net (learned from production):** Even with try/catch in the REPL, floating promises from missing `await` can cause unhandled rejections. Add this in the main process:

```ts
process.on('unhandledRejection', (reason, promise) => {
  console.error('[RLM] Unhandled rejection caught:', reason);
  emitToCommandCenter('rlm:error', { 
    error: `Unhandled async error: ${reason}` 
  });
  // Do NOT crash — log it and continue
});
```

### Abort Strategy
The `rlm:cancel` IPC message needs to actually interrupt a running loop. `isolate.dispose()` kills everything but is too aggressive — it destroys REPL state. Use an AbortController-style approach:

```ts
class RLMRun {
  private abortController = new AbortController();
  
  get signal() { return this.abortController.signal; }
  
  cancel() { this.abortController.abort(); }
  
  async runLoop() {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (this.signal.aborted) {
        emitToCommandCenter('rlm:complete', { 
          final: 'Task cancelled by user. Partial results may be available in the activity log.' 
        });
        return;
      }
      
      // Check signal between each major operation:
      const llmResponse = await this.callLLM();   // check after
      if (this.signal.aborted) return;
      
      const result = await this.executeREPL(code); // check after
      if (this.signal.aborted) return;
      
      // ... continue loop
    }
  }
}
```

Each `execInTab` call also needs its own timeout (10s default, separate from the 30s per-iteration timeout) so a hung page doesn't block the entire run.

### Navigation-Aware Error Messages
When `execInTab` fails because the page navigated since the LLM last interacted with it, don't just show the raw error. Detect the navigation and tell the LLM explicitly:

```ts
async function execInTabSafe(tabId: string, code: string, lastKnownUrl: string): Promise<any> {
  const currentUrl = tabManager.getUrl(tabId);
  
  try {
    return await tabManager.exec(tabId, code);
  } catch (err) {
    if (currentUrl !== lastKnownUrl) {
      throw new Error(
        `${err.message}\n[PAGE NAVIGATED] Tab ${tabId} URL changed from "${lastKnownUrl}" to "${currentUrl}" since your last interaction. Update your selectors for the new page.`
      );
    }
    throw err;
  }
}
```

Without this, the LLM wastes 2-3 iterations diagnosing why selectors that worked before are returning null.

### Metadata Summary Generation
After each execution, generate a RICH metadata summary. This is what goes into the LLM's history, NOT the raw output. The quality of this metadata is CRITICAL — it's the only way the LLM knows what it's working with, so it must include type information, structure, and shape.

```ts
function summarize(code: string, result: any): string {
  const type = typeof result;
  const str = JSON.stringify(result);
  const size = str?.length ?? 0;
  
  let summary = `Code:\n${code}\n`;
  
  if (result === undefined || result === null) {
    summary += `Result: ${result === null ? 'null' : 'void'}`;
  
  } else if (Array.isArray(result)) {
    // For arrays, show length + element type + structure of first element
    const elementType = result.length > 0 ? describeType(result[0]) : 'empty';
    summary += `Result: Array<${elementType}> (${result.length} items, ${size} chars total)`;
    if (result.length > 0 && typeof result[0] === 'object') {
      summary += `\nElement schema: ${describeObjectSchema(result[0])}`;
    }
    summary += `\nPreview (first 2): ${JSON.stringify(result.slice(0, 2), null, 0).slice(0, 400)}`;
    if (result.length > 2) summary += `\n... and ${result.length - 2} more items`;
  
  } else if (type === 'object') {
    // For objects, show all keys with their types and value previews
    const keys = Object.keys(result);
    summary += `Result: Object (${keys.length} keys, ${size} chars)`;
    summary += `\nSchema: ${describeObjectSchema(result)}`;
    summary += `\nPreview: ${JSON.stringify(result, null, 0).slice(0, 400)}${size > 400 ? '...' : ''}`;
  
  } else if (type === 'string' && size > 300) {
    summary += `Result: string (${size} chars)`;
    summary += `\nPreview: "${result.slice(0, 250)}..."`;
  
  } else {
    // Primitives — just show the value
    summary += `Result: ${type} = ${str.slice(0, 300)}`;
  }
  
  return summary;
}

// Describe the schema of an object with key names and value types
function describeObjectSchema(obj: any): string {
  if (typeof obj !== 'object' || obj === null) return typeof obj;
  if (Array.isArray(obj)) return `Array<${obj.length > 0 ? describeType(obj[0]) : 'unknown'}>`;
  
  const fields = Object.entries(obj).map(([key, val]) => {
    const t = describeType(val);
    const preview = typeof val === 'string' ? ` "${String(val).slice(0, 40)}${String(val).length > 40 ? '...' : ''}"` :
                    typeof val === 'number' || typeof val === 'boolean' ? ` ${val}` : '';
    return `${key}: ${t}${preview}`;
  });
  return `{ ${fields.join(', ')} }`;
}

// Concise type description including nested structure
function describeType(val: any): string {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (Array.isArray(val)) return `Array<${val.length > 0 ? describeType(val[0]) : 'unknown'}>(${val.length})`;
  if (typeof val === 'object') return `Object(${Object.keys(val).length} keys: ${Object.keys(val).join(', ')})`;
  return typeof val;
}
```

**Example of GOOD metadata (what the LLM sees):**
```
Code:
  const emails = await execInTab('tab_a', `
    [...document.querySelectorAll('.zA.zE')].map(el => ({
      subject: el.querySelector('.bog span')?.innerText,
      sender: el.querySelector('.yW span')?.getAttribute('name'),
      snippet: el.querySelector('.y2')?.innerText,
      timestamp: el.querySelector('.xW.xY span')?.getAttribute('title')
    }))
  `)
Result: Array<Object(4 keys: subject, sender, snippet, timestamp)> (3 items, 487 chars total)
Element schema: { subject: string "Meeting tomorrow at 3pm", sender: string "Alice Chen", snippet: string "Hi, just wanted to confirm...", timestamp: string "Feb 15, 2026, 2:34 PM" }
Preview (first 2): [{"subject":"Meeting tomorrow at 3pm","sender":"Alice Chen","snippet":"Hi, just wanted to confirm our meeting...","timestamp":"Feb 15, 2026, 2:34 PM"},{"subject":"Invoice #4521","sender":"Billing Dept","snippet":"Your invoice is ready...","timestamp":"Feb 15, 2026, 11:02 AM"}]
... and 1 more items
```

**Example of BAD metadata (never do this):**
```
Result: object[] (3 items, 487 chars)
```

The rich metadata lets the LLM know exactly what fields are available, what types they are, and what the data looks like — so it can write precise code in the next iteration without guessing.

### Environment Metadata Generation
Each iteration, build a fresh snapshot:

```ts
function buildEnvMetadata(): string {
  const tabList = tabManager.getAllTabs().map((t, i) =>
    `  [${i}] id:${t.id} | ${t.url} | "${t.title}" | ${t.status}`
  ).join('\n');
  
  const vars = repl.getVariables().map(v =>
    `  ${v.name}: ${v.type}${v.size ? ` (${v.size})` : ''} = ${v.preview}`
  ).join('\n');
  
  return `## Browser State\nOpen tabs (${tabs.length}):\n${tabList}\n\n## REPL Variables\n${vars}`;
}
```

### Error Handling Per Iteration
If REPL execution throws, catch it, include the error in the metadata summary, and let the LLM see it so it can self-correct:

```
Result: ERROR — TypeError: Cannot read property 'length' of null
  at execInTab result for tab_a, selector ".zA.zE" matched 0 elements
```

The LLM typically self-corrects within 1-2 iterations when it can see its own errors.

---

## 9. LLM CONFIGURATION

### Default Model
- **Primary:** Claude Sonnet 4 (claude-sonnet-4-20250514) — best speed/quality for iterative code gen
- **Complex tasks:** Claude Opus — user can select in settings
- **Sub-calls:** Use same model as primary, or allow downgrade to Haiku for simple extraction sub-tasks

### API Parameters
```ts
{
  model: "claude-sonnet-4-20250514",
  max_tokens: 4096,          // Per iteration — code blocks are usually short
  temperature: 0,            // Deterministic code generation
  stream: true,              // REQUIRED — stream tokens to Command Center in real-time
  system: systemPrompt,      // From Section 4
  messages: contextMessages   // Built by context builder
}
```

**Streaming is non-negotiable.** Browser automation iterations can take 30+ seconds (page loads + LLM generation). Without streaming, the Command Center UI goes dark and the user thinks it's frozen. Stream tokens to the activity panel as they arrive, then parse code blocks from the complete response.

### Sub-Model Configuration
Sub-calls via `llm_query()` and `llm_batch()` will be high-volume (summarize each email, classify each tab, extract each row). Make sub-model a first-class config option:

```ts
// In settings
{
  primaryModel: "claude-sonnet-4-20250514",   // Main loop iterations
  subModel: "claude-haiku-4-5-20251001",      // Sub-calls (cheaper, faster)
}
```

Both are selectable in the Command Center settings UI. Default sub-model to Haiku — most sub-tasks are extraction/summarization where speed and cost matter more than reasoning depth.

### LLM Response Parsing
The LLM's response will contain a mix of prose (thinking/planning) and code blocks. Parsing code blocks is harder than it looks — models frequently deviate from the expected format.

**Use a fallback chain, not a single regex:**
```ts
function extractCodeBlocks(response: string): string[] {
  // Strategy 1: Fenced ```repl blocks (preferred)
  let blocks = extractFenced(response, 'repl');
  if (blocks.length > 0) return blocks;
  
  // Strategy 2: Any fenced code block (```js, ```javascript, ```, etc.)
  blocks = extractAnyFenced(response);
  if (blocks.length > 0) return blocks;
  
  // Strategy 3: Tool-call JSON format (some models output {"code":"..."})
  blocks = extractFromToolCallJSON(response);
  if (blocks.length > 0) return blocks;
  
  // Strategy 4: Bare code detection — look for lines that look like JS
  // (starts with const/let/var/await/FINAL, contains function calls, etc.)
  blocks = extractBareCode(response);
  return blocks; // may be empty — that's fine, triggers continuation prompt
}

function extractFenced(response: string, tag: string): string[] {
  const regex = new RegExp('```' + tag + '\\n([\\s\\S]*?)```', 'g');
  const blocks = [];
  let match;
  while ((match = regex.exec(response)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

function extractAnyFenced(response: string): string[] {
  const regex = /```(?:\w*)\n([\s\S]*?)```/g;
  const blocks = [];
  let match;
  while ((match = regex.exec(response)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}
```

**The system prompt must HAMMER the code format — a single mention gets lost after 5+ iterations:**

```
## ⚠️ CRITICAL: Code Format ⚠️
You MUST wrap all executable code in ```repl blocks.
THIS IS THE ONLY WAY TO EXECUTE CODE.
Do NOT use ```js, ```javascript, or any other tag.
Do NOT describe code you would write — WRITE IT.
If you are planning, still write code. Planning without code wastes an iteration.
```

**Special handling for iteration 0:** If the first iteration produces no code blocks, it's almost always the model describing what it *would* do instead of doing it. The continuation prompt for iter 0 should be more aggressive: `"You described your plan but did not write any code. Write the code now in a \`\`\`repl block to begin."`

If the response contains NO code blocks, DO NOT treat this as the loop ending. LLMs often think out loud or plan before writing code. Instead, send a continuation prompt: `"Continue — write code in a \`\`\`repl block to proceed with the task, or call setFinal(value) to deliver your response to the user."` For iteration 0 specifically, be more aggressive: `"You described your plan but did not write any code. Write the code now in a \`\`\`repl block to begin."`

The ONLY way the loop terminates is:
1. `setFinal(value)` is called in the REPL
2. The iteration cap is hit (then deliver whatever partial results exist)
3. The user cancels

If the response contains code blocks, execute ALL of them sequentially within the same REPL context in a single iteration. This is important — the LLM often writes setup code in one block and the main logic in another within the same response. Don't treat each block as a separate iteration.

**Generate PER-BLOCK result entries in the metadata** — not one combined summary. If block 1 succeeds and block 2 throws, the LLM needs to see that distinction to self-correct:

```
## Iteration 3 (2 code blocks)
Block 1:
  Code: env.emailSelector = '.zA.zE'
  Result: void (assignment)

Block 2:
  Code: env.emails = await execInTab('tab_a', `...`)
  Result: ERROR — TypeError: Cannot read property 'map' of null
    Hint: page may have changed — URL is now gmail.com/mail/u/0/#inbox/FMfcg...
```

A single combined summary would hide which block failed.

---

## 10. SECURITY CONSIDERATIONS

### Sandbox: isolated-vm (non-negotiable)
Use `isolated-vm`, not Node's `vm` module. See Section 8 for implementation. LLM-generated code has access to `executeJavaScript` on real browser tabs — this is a real security boundary.

### Sensitive Action Detection (concrete design)
The LLM writes arbitrary JS via `execInTab`, so we can't just gate on REPL API names. Three layers:

**Layer 1 — REPL API level gating:**
Actions like `click`, `type`, `fill` go through the REPL API. Before executing, check if the target element is a submit button, payment form, delete button, send button, etc.:
```ts
async function click(tabId: string, selector: string): Promise<void> {
  // Pre-check: what are we about to click?
  const elementInfo = await execInTab(tabId, `
    const el = document.querySelector('${selector}');
    ({ tagName: el?.tagName, type: el?.type, innerText: el?.innerText?.slice(0,50),
       formAction: el?.form?.action, role: el?.getAttribute('role') })
  `);
  
  if (isSensitiveAction(elementInfo)) {
    const approved = await requestUserConfirmation(
      `The AI wants to click "${elementInfo.innerText}" on ${getTabUrl(tabId)}. Allow?`
    );
    if (!approved) return;
  }
  // proceed with click
}

function isSensitiveAction(el: any): boolean {
  const dangerousText = /submit|purchase|buy|pay|send|delete|remove|confirm|sign|transfer|order/i;
  const dangerousTypes = ['submit'];
  return dangerousTypes.includes(el.type) || dangerousText.test(el.innerText);
}
```

**Layer 2 — Network request interception:**
After any `execInTab` that might trigger navigation or form submission, intercept outgoing requests:
```ts
webContents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
  if (details.method === 'POST' && isRLMInitiated(details)) {
    // Queue for user confirmation if it's a form submission, payment, etc.
    queueSensitiveRequestConfirmation(details, callback);
  } else {
    callback({ cancel: false });
  }
});
```

**Layer 3 — LLM self-declaration (supplementary, not primary):**
The system prompt asks the LLM to call `log("[SENSITIVE] About to submit form...")` before dangerous actions. This is unreliable and should NOT be the primary gate, but it helps surface intent in the activity panel.

### Concurrent Tab Operations
Sub-calls via `llm_query()` do NOT get access to `execInTab` or any browser-modifying functions. Sub-calls are for data processing only — they receive data as a string/object and return a string result. This prevents concurrent access to shared browser state from sub-agents.

Only the main RLM loop (one iteration at a time, sequential) can interact with tabs. If you need to process data from multiple tabs in parallel, the main loop extracts the data first, then fans out to sub-calls for processing.

### Other Security Measures
- **API key storage:** Encrypted in OS keychain (use `safeStorage` from Electron), not plaintext
- **Network interception:** Read-only by default. The RLM can observe requests but not modify them unless user explicitly enables it
- **Rate limiting:** Max 25 iterations per run. Max 50 sub-LLM calls per run. User can override in settings
- **Content Security Policy:** Standard Electron CSP for the chrome/command-center renderers
- **Global rejection handler:** Catches unhandled promise rejections from missing `await` in LLM code (see Section 8)

---

## 11. EXAMPLE FLOWS

### "Summarize my unread Gmail"
```
User: "Summarize my unread emails in Gmail"

Iter 1: LLM sees tab_a is gmail.com
  Code: const unread = await execInTab('tab_a', `
    [...document.querySelectorAll('.zA.zE')].map(el => ({
      subject: el.querySelector('.bog span')?.innerText,
      sender: el.querySelector('.yW span')?.getAttribute('name'),
      snippet: el.querySelector('.y2')?.innerText
    }))
  `)
  Result: object[] (3 items, 487 chars)

Iter 2: LLM gets previews from metadata, wants full email bodies
  Code: // Click first email to open it
  await click('tab_a', '.zA.zE:first-child')
  await sleep(1000)
  const body1 = await getText('tab_a', '.a3s.aiL')
  Result: string (2,341 chars)

Iter 3: Use sub-LLM to summarize
  Code: const summary1 = await llm_query(
    "Summarize this email in 2 sentences", body1
  )
  Result: string (89 chars)

... repeat for other emails ...

Iter 7:
  Code: setFinal(`You have 3 unread emails:\n\n1. ${env.summary1}\n2. ${env.summary2}\n3. ${env.summary3}`)
  → Returned to user in chat
```

### "Find the cheapest flight to Denver next Friday on Google Flights"
```
Iter 1: Code: const tid = await openTab('https://www.google.com/travel/flights')
        await waitForLoad(tid)
Iter 2: Code: await type(tid, '[aria-label="Where to?"]', 'Denver')
        await sleep(500)
        await click(tid, '[data-value="DEN"]')
Iter 3: Code: // Set date... navigate results...
Iter 4: Code: const flights = await execInTab(tid, `...extract flight cards...`)
Iter 5: Code: env.flights = flights.sort((a,b) => a.price - b.price)
        setFinal(`Cheapest flight: ${env.flights[0].airline} at $${env.flights[0].price}, departs ${env.flights[0].time}`)
```

---

## 12. DEVELOPMENT COMMANDS

```bash
# Install dependencies
npm install

# Dev mode with hot reload
npm run dev

# Build for production  
npm run build

# Run tests
npm test

# Package for distribution
npm run package
```

---

## 13. DEPENDENCIES (expected)

```json
{
  "electron": "^33.0.0",
  "react": "^19.0.0",
  "react-dom": "^19.0.0",
  "@anthropic-ai/sdk": "latest",
  "electron-store": "^8.0.0",        // Settings persistence  
  "isolated-vm": "^5.0.0",           // REPL sandboxing (required — vm module is NOT safe)
  "typescript": "^5.5.0",
  "vite": "^6.0.0",                  // Build tool
  "vite-plugin-electron": "latest"    // Electron + Vite integration
}
```

---

## REMEMBER

1. **The LLM never sees raw page content in its context.** Always metadata + REPL code access.
2. **History is metadata-only.** Code + rich structural summary (types, schemas, previews). Never raw stdout.
3. **Symbolic recursion via `llm_query()` is the superpower.** It's what lets the RLM handle 50-email inboxes, 100-row tables, etc. without context window limits.
4. **`execInTab` is the primitive.** Everything else is built on top of it.
5. **The Command Center shows everything.** Stream LLM tokens in real-time. The user should watch the RLM think, see every code block, every result, every sub-call.
6. **Sub-calls get the FULL system prompt + task context.** Never send a naked prompt — sub-agents without identity produce garbage.
7. **Sub-call errors return strings, never throw.** Use try/catch wrapper. `llm_batch` uses `allSettled`, not `all`. One failure must not kill the batch or crash the app.
8. **Task reinforcement EVERY iteration.** Re-state the user's goal and current progress. Progress is auto-generated from iteration metadata, NOT dependent on `log()` calls.
9. **`setFinal(value)` is the ONLY termination signal.** No code blocks ≠ done. Send a continuation prompt. Iter 0 with no code gets an aggressive nudge.
10. **Use isolated-vm, not vm.** Node's vm is not a sandbox. This is a real security boundary.
11. **Detect page changes between iterations.** Diff URL/title/status and tell the LLM. When execInTab fails after a navigation, include the navigation info in the error message.
12. **Sub-calls are data-processing only.** No `execInTab` access from sub-agents. Only the main loop touches the browser.
13. **Store variables on `env` object.** Prevents namespace collisions, makes metadata generation trivial (enumerate `env` keys).
14. **Cap `execInTab` results at ~100k chars.** Tell the LLM "result truncated, use a more specific selector." Cap `sleep()` at 10 seconds. Prefer `waitForLoad()` over `sleep()`.
15. **Per-block metadata.** When multiple code blocks execute in one iteration, generate separate result entries per block so the LLM knows which block succeeded/failed.
16. **Stream LLM responses.** For iterations that take 30+ seconds (page loads + generation), the UI must show tokens as they arrive. No streaming = UI goes dark.
17. **History compaction is token-based, not iteration-based.** Trigger at 80% of budget. Keep last 3 full, condense the rest. One fat iteration can blow the budget at iter 4.
18. **Code block parsing needs a fallback chain.** Fenced ```repl → any fenced → tool-call JSON → bare code. Models deviate from the expected format constantly.
19. **Sub-model is a first-class config option.** Separate model selection for main loop vs sub-calls. Sub-calls are high-volume — cost control matters from day one.
