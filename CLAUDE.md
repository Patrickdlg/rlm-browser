# CLAUDE.md — Ouroboros (RLM Browser)

An Electron-based web browser where a Recursive Language Model engine has deep programmatic introspection into all browser state. The user browses normally, then instructs the LLM to operate across their tabs from the Command Center.

---

## RLM Core Concepts

RLM = Recursive Language Model (Zhang, Kraska, Khattab — MIT CSAIL, Jan 2026).

### The Loop (Algorithm 1)

```
1. Initialize REPL with browser state accessible as variables
2. Capture user's request as taskGoal (persists entire run)
3. LLM receives: system prompt + TASK REINFORCEMENT + environment METADATA + action history
4. LLM generates code (JavaScript in ```repl blocks)
5. No code blocks → continuation prompt, go to step 3
6. Execute ALL code blocks in REPL → capture per-block metadata summaries
7. Append to history: code + METADATA-ONLY summary (NOT raw output)
8. Diff tab state — flag URL/title/status changes since last iteration
9. setFinal() called → return result to user, done
10. Else → go to step 3
11. Hard cap at 25 iterations → deliver partial results
```

### Three Pillars — Never Violate

1. **Data as external variable.** Browser state is accessed via REPL API calls. The LLM context only holds metadata summaries (type, size, schema, preview). Never raw page content.

2. **Output through REPL state, not generation.** Results delivered via `setFinal(value)`. Output length is unbounded — the model builds up results in `env` variables across iterations.

3. **Symbolic recursion.** `llm_query(prompt, data?)` spawns a fresh sub-agent with its own REPL and full browser access. Sub-agents run as mini RLM loops (up to 10 iterations) with the same resilience as the main loop.

### Key Design Rules

- **Metadata-only history.** After each execution, append code + structural result summary (type, size, schema, preview). Never raw stdout.
- **Task reinforcement every iteration.** User's goal + auto-generated progress restated at the top of context. Progress derived from iteration metadata, NOT from `log()` calls.
- **Tabs are external variables.** Context only shows tab count + active tab ID. The LLM queries `tabs` getter via code to discover tabs.
- **Per-block metadata.** Multiple code blocks in one iteration get separate result entries so the LLM sees which block succeeded/failed.
- **`setFinal()` is the ONLY termination signal.** No code blocks does NOT end the loop — it triggers a continuation prompt.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Electron App                      │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │             Main Process (Node.js)              │  │
│  │                                                 │  │
│  │  TabManager          RLM Engine                 │  │
│  │  (WebContentsView    ├─ REPL (isolated-vm v6)   │  │
│  │   lifecycle)         ├─ Context Builder          │  │
│  │                      ├─ LLM Client (streaming)   │  │
│  │                      └─ Loop Controller          │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─────────────┐  ┌─────────┐  ┌─────────┐          │
│  │  Command     │  │  Tab 1  │  │  Tab 2  │  ...     │
│  │  Center      │  │  gmail  │  │  github │          │
│  │  (React)     │  │  (WCV)  │  │  (WCV)  │          │
│  └─────────────┘  └─────────┘  └─────────┘          │
│                                                      │
│  WCV = WebContentsView                               │
└─────────────────────────────────────────────────────┘
```

- **Main process** owns the RLM engine, REPL, LLM client, and tab management. Direct access to all `webContents`.
- **Command Center** is a React WebContentsView — shows chat, streaming tokens, code blocks, results, sub-calls.
- **User tabs** are standard WebContentsViews. The RLM can introspect and act on any tab via the REPL API.
- **`execInTab`** is the primitive. Calls `webContents.executeJavaScript()` on any tab. Everything else is built on top.

---

## File Structure

```
electron/
├── main/
│   ├── index.ts                    # App entry, BaseWindow + WebContentsView layout
│   ├── tabs/
│   │   ├── TabManager.ts           # WCV lifecycle, exec, tab state
│   │   ├── TabState.ts             # Tab metadata model
│   │   └── TabDiffer.ts            # URL/title/status diffing between iterations
│   ├── rlm/
│   │   ├── engine.ts               # Algorithm 1 loop controller (~530 lines)
│   │   ├── repl.ts                 # isolated-vm runtime + full API surface (~440 lines)
│   │   ├── context.ts              # System prompt builder + context assembly
│   │   ├── llm-client.ts           # Anthropic + OpenAI dual provider, streaming
│   │   ├── task-tracker.ts         # Task reinforcement generator
│   │   ├── parser.ts               # Code block extraction (4-strategy fallback)
│   │   ├── history.ts              # Token-based adaptive compaction
│   │   └── caps.ts                 # Constants + utility functions
│   ├── ipc/
│   │   └── handlers.ts             # IPC endpoint registration
│   └── store/
│       └── persistent.ts           # electron-store + safeStorage encryption
├── preload/
│   ├── chrome.ts                   # Tab management bridge (contextBridge)
│   └── command-center.ts           # RLM bridge (contextBridge)
src/
├── shared/
│   ├── types.ts                    # All shared TypeScript interfaces
│   └── ipc-channels.ts            # IPC channel string constants
├── chrome/                         # Browser chrome UI (React)
│   ├── App.tsx, TabBar.tsx, AddressBar.tsx, NavigationControls.tsx
│   └── index.html, main.tsx
└── command-center/                 # RLM Command Center UI (React)
    ├── App.tsx                     # State management, IPC event handlers
    ├── Chat.tsx                    # User input + submit/cancel
    ├── ActivityPanel.tsx           # Real-time iteration timeline
    ├── IterationCard.tsx           # Expandable per-iteration details
    ├── OutputPanel.tsx             # Final result display
    ├── Settings.tsx                # Provider, API key, model config
    └── index.html, main.tsx
```

---

## REPL API Surface

All functions available in the isolated-vm sandbox. Tab IDs are strings like `"tab_0"`.

### Tab Management
```js
tabs                          // Array<{id, url, title, status, favicon}> — live getter
activeTab                     // Current focused tab id (string) — live getter
openTab(url?) → tabId         // Opens new tab, returns id
closeTab(tabId)               // Closes tab
navigate(tabId, url)          // Navigate existing tab
switchTab(tabId)              // Bring tab to focus
waitForLoad(tabId, timeout?)  // Wait until tab finishes loading (default 30s)
```

### DOM Introspection
```js
execInTab(tabId, jsCode) → any              // Execute JS in tab's context (capped at 100k chars)
getText(tabId, selector?) → string           // innerText of element
getDOM(tabId, selector?) → string            // outerHTML of element
getLinks(tabId) → Array<{text, href}>
getInputs(tabId) → Array<{id, name, type, value, placeholder}>
querySelector(tabId, sel) → {tagName, id, className, innerText, href, src, value, type} | null
querySelectorAll(tabId, sel) → Array<{tagName, id, className, innerText, href, src}>
```

### Browser Actions
```js
click(tabId, selector)              // Click an element
type(tabId, selector, text)         // Type into input field
fill(tabId, formData)               // Fill form: {selector: value, ...}
scroll(tabId, direction, amount?)   // Scroll 'up'/'down' (default 500px)
keyPress(tabId, key, modifiers?)    // Keyboard event
hover(tabId, selector)              // Mouse hover
select(tabId, selector, value)      // Select dropdown option
```

### Recursive LLM Calls
```js
llm_query(prompt, data?) → string                    // Spawns a sub-agent mini RLM loop
llm_batch(prompts) → Array<{status, value?, error?}> // Parallel batch (allSettled)
```

Sub-agents are full mini RLM loops with fresh REPLs, full browser access, up to 10 iterations, and the same resilience as the main loop. They receive the same system prompt (minus `llm_query`/`llm_batch` to prevent nesting) + task context. Errors return strings with `[SUB-CALL ERROR]` prefix, never throw.

### State & Output
```js
env.myVar = value              // Store variables on env object
setFinal(value)                // End loop, deliver result — MUST be called when done
log(message)                   // Log to activity panel (auto-truncated at 5k chars)
sleep(ms)                      // Async wait (CAPPED AT 10 SECONDS)
store(key, value)              // Persistent k/v store across runs
retrieve(key) → value          // Retrieve from persistent store
```

---

## Constants (caps.ts)

| Constant | Value | Purpose |
|---|---|---|
| `EXEC_RESULT_CAP` | 100,000 chars | `execInTab` result truncation |
| `SLEEP_CAP_MS` | 10,000 ms | `sleep()` max duration |
| `EXEC_TIMEOUT_MS` | 30,000 ms | Per-code-block execution timeout |
| `EXEC_IN_TAB_TIMEOUT_MS` | 10,000 ms | Per-`execInTab` call timeout |
| `MAX_ITERATIONS` | 25 | Main loop cap |
| `MAX_SUB_CALLS` | 50 | Sub-LLM call cap per run |
| `MAX_NO_CODE_CONTINUATIONS` | 3 | Bail after N iterations with no code |
| `HISTORY_TOKEN_BUDGET` | 8,000 tokens | Action history max |
| `HISTORY_COMPACTION_THRESHOLD` | 80% of budget | Triggers compaction |
| `PREVIEW_MAX_CHARS` | 400 | Metadata preview truncation |
| `VAR_PREVIEW_MAX_CHARS` | 200 | Env variable preview |
| `LOG_MAX_CHARS` | 5,000 | `log()` message truncation |
| `ISOLATE_MEMORY_LIMIT_MB` | 128 | isolated-vm memory limit |

---

## Context Builder

Each iteration, the LLM receives a single user message containing:

1. **Task Reinforcement** — user's request, iteration number, auto-generated progress from iteration metadata
2. **Page Changes** — URL/title/status diffs since last iteration (only if changes occurred)
3. **Environment Metadata** — tab count + active tab ID (NOT full tab list), REPL variable schemas with type/size/preview
4. **Action History** — compacted iteration records. Last 3 at full detail, older condensed to one-liners. Triggers compaction at 80% of 8000-token budget.

### System Prompt

Built by `getSystemPrompt({ isSubCall?: boolean })` in `context.ts`. Contains:
- Identity + rules (13 bullet points)
- Full REPL API reference with return types
- Code format requirements (hammered with `⚠️ CRITICAL` sections)
- Example traces showing natural flow: store variable → check metadata → setFinal

Sub-call system prompt is identical but excludes `llm_query`/`llm_batch` section and adds a rule that they're not available.

---

## IPC Channels

### Renderer → Main (invoke)
```
tab:open, tab:close, tab:switch, tab:navigate, tab:go-back, tab:go-forward, tab:reload
tab:get-all, tab:get-active
rlm:submit-task, rlm:cancel, rlm:get-state, rlm:confirmation-resp
settings:get, settings:set
```

### Main → Renderer (send)
```
tab:updated, tab:active-changed, tab:closed
rlm:iteration-start    {iteration, taskGoal}
rlm:stream-token       {token, iteration}
rlm:code-generated     {code, blockIndex}
rlm:code-result        {metadata, blockIndex, error?}
rlm:sub-llm-start      {prompt}
rlm:sub-llm-complete   {resultMeta}
rlm:page-changes       {changes: TabChange[]}
rlm:log                {message}
rlm:error              {error}
rlm:complete           {final}
rlm:env-update         {metadata}
rlm:confirmation-req   {action, details}
```

---

## Build Gotchas

1. **isolated-vm v6 required.** v5 compiles with C++17 but Electron 35's V8 13.5 requires C++20. Use `^6.0.2`.
2. **electron-store v10 is ESM-only.** Must be excluded from `externalizeDepsPlugin` in `electron.vite.config.ts` so Vite bundles it. Otherwise Electron's CJS loader can't import it.
3. **Preload scripts can't import shared modules.** Electron sandboxed preloads can't resolve chunk imports. Use inline string literals for IPC channel names instead of importing from `src/shared/ipc-channels.ts`.
4. **`@electron/rebuild`** — use the scoped package, not the deprecated `electron-rebuild`.
5. **Postinstall hook** runs `electron-rebuild -f -w isolated-vm` to rebuild native bindings.

---

## Tech Stack

| Dependency | Version | Notes |
|---|---|---|
| Electron | ^35 | WebContentsView, BaseWindow |
| React | ^19 | Both chrome and command-center UIs |
| Tailwind | ^4 | Via `@tailwindcss/vite` plugin |
| isolated-vm | ^6.0.2 | V8 isolate sandbox for REPL |
| @anthropic-ai/sdk | ^0.39 | Anthropic provider |
| openai | ^4.82 | OpenAI-compatible provider (vLLM, Ollama) |
| electron-store | ^10 | Settings persistence (ESM-only) |
| electron-vite | ^3 | Build tool (three-section config: main, preload, renderer) |

---

## Development

```bash
nvm use               # Node 24 LTS (.nvmrc → lts/*)
npm install           # Includes native rebuild of isolated-vm
npm run dev           # Dev mode with hot reload
npm run build         # Production build
npm run package       # Package for distribution
```

---

## REMEMBER

1. **Data never enters the LLM context.** Browser state lives as REPL variables. Only metadata in context.
2. **History is metadata-only.** Code + structural summary (type, size, schema, preview). Never raw output.
3. **Symbolic recursion via `llm_query()`.** Sub-agents are full mini RLM loops with browser access and fresh REPLs. They get the same system prompt minus `llm_query`/`llm_batch`.
4. **`execInTab` is the primitive.** Everything else is built on top.
5. **Stream everything to the Command Center.** Tokens in real-time, code blocks, results, sub-calls, errors.
6. **Sub-call errors return strings, never throw.** `llm_batch` uses `allSettled`. One failure must not crash the run.
7. **Task reinforcement EVERY iteration.** Progress auto-generated from iteration metadata, NOT from `log()`.
8. **`setFinal(value)` is the ONLY termination signal.** No code blocks triggers a continuation prompt, not termination.
9. **Use isolated-vm v6, not Node's vm.** Real security boundary — LLM code can execute JS on user's bank tabs.
10. **Tabs are external variables.** Context only shows count + active ID. LLM queries `tabs` getter via code.
11. **Per-block metadata.** Separate result entries per code block so the LLM sees which succeeded/failed.
12. **Token-based history compaction.** Triggers at 80% of budget. Keep last 3 full, condense the rest.
13. **Code block parsing fallback chain.** Fenced `repl` → any fenced → tool-call JSON → bare code detection.
14. **Cap everything.** `execInTab` at 100k chars. `sleep()` at 10s. `log()` at 5k chars. Isolate at 128MB.
