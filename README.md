# Ouroboros

An Electron-based web browser where a Recursive Language Model engine has deep programmatic introspection into all browser state. Browse normally — then instruct the LLM to operate across your tabs, sessions, and data from the Command Center.

Based on the [RLM paper](https://arxiv.org/abs/2502.07476) (Zhang, Kraska, Khattab — MIT CSAIL, Jan 2026).

## How It Works

The RLM engine treats your browser tabs as external variables in a sandboxed REPL. The LLM never sees raw page content in its context window — it writes JavaScript code to interact with pages surgically, stores intermediate results, and spawns sub-LLM calls for data processing. Results are delivered via `setFinal()`.

```
User: "Summarize my unread emails in Gmail"

Iter 1: queries unread count via DOM → 3
Iter 2: extracts email subjects and senders → Array<Object>(3)
Iter 3: clicks first email, extracts body → string (2,341 chars)
Iter 4: llm_query("Summarize this email", body) → string (89 chars)
...
Iter 7: setFinal("You have 3 unread emails: 1. ...")
```

The Command Center shows every iteration in real time — streaming LLM tokens, code blocks, execution results, sub-calls, and errors.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Electron App                      │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │             Main Process (Node.js)              │  │
│  │                                                 │  │
│  │  TabManager          RLM Engine                 │  │
│  │  (WebContentsView    ├─ REPL (isolated-vm)      │  │
│  │   lifecycle)         ├─ Context Builder          │  │
│  │                      ├─ LLM Client (streaming)   │  │
│  │                      └─ Loop Controller          │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─────────────┐  ┌─────────┐  ┌─────────┐          │
│  │  Command     │  │  Tab 1  │  │  Tab 2  │  ...     │
│  │  Center      │  │  gmail  │  │  github │          │
│  │  (React)     │  │         │  │         │          │
│  └─────────────┘  └─────────┘  └─────────┘          │
└─────────────────────────────────────────────────────┘
```

## Setup

Requires Node.js 22+ (24 LTS recommended) and a C++ compiler for `isolated-vm`.

```bash
# Use the right Node version
nvm use

# Install dependencies (includes native rebuild of isolated-vm)
npm install

# Start in dev mode
npm run dev
```

## Configuration

Open the **Settings** panel in the Command Center to configure:

- **Provider** — Anthropic or OpenAI-compatible (vLLM, Ollama, etc.)
- **API Key** — encrypted at rest via Electron's safeStorage
- **Base URL** — for local/self-hosted endpoints (e.g. `http://localhost:8000/v1`)
- **Primary Model** — used for the main RLM loop (default: `claude-sonnet-4-20250514`)
- **Sub Model** — used for `llm_query()`/`llm_batch()` calls (default: `claude-haiku-4-5-20251001`)
- **Max Iterations** — per-run cap (default: 25)
- **Max Sub-Calls** — per-run cap (default: 50)

## REPL API

The LLM writes code against this API surface inside a sandboxed `isolated-vm` isolate:

| Category | Functions |
|---|---|
| Tabs | `tabs`, `activeTab`, `openTab()`, `closeTab()`, `navigate()`, `switchTab()`, `waitForLoad()` |
| DOM | `execInTab()`, `getText()`, `getDOM()`, `getLinks()`, `getInputs()`, `querySelector()`, `querySelectorAll()` |
| Actions | `click()`, `type()`, `scroll()` |
| LLM | `llm_query(prompt, data?)`, `llm_batch(prompts)` |
| State | `env.*`, `setFinal(value)`, `log()`, `sleep()` |

## Key Design Decisions

- **Data never enters the LLM context.** Browser state lives as REPL variables. The LLM only sees metadata summaries (type, size, schema, preview).
- **History is metadata-only.** Each iteration records: code executed + structural result summary. Never raw output.
- **Sub-calls get full context.** Every `llm_query()` sub-agent receives the system prompt + task context. Errors return strings, never throw.
- **Task reinforcement every iteration.** The user's goal and auto-generated progress are restated to prevent drift.
- **Token-based history compaction.** Triggers at 80% of budget, not at a fixed iteration count.
- **`isolated-vm` sandbox.** LLM-generated code runs in a separate V8 isolate with no access to Node.js APIs — only the explicitly exposed REPL surface.

## Tech Stack

- Electron 35 (WebContentsView)
- React 19 + Tailwind 4
- isolated-vm 6 (V8 isolate sandbox)
- Anthropic SDK + OpenAI SDK (dual provider)
- electron-vite 3
- electron-store (settings persistence)

## Scripts

```bash
npm run dev       # Dev mode with hot reload
npm run build     # Production build
npm run package   # Package for distribution
```

## License

MIT
