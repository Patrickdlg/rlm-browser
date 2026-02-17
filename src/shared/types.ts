// --- Tab Types ---

export interface TabInfo {
  id: string
  url: string
  title: string
  status: 'loading' | 'loaded' | 'error'
  favicon: string
  canGoBack: boolean
  canGoForward: boolean
}

export interface TabSnapshot {
  url: string
  title: string
  status: string
}

export interface TabChange {
  tabId: string
  field: 'url' | 'title' | 'status'
  old: string
  new: string
}

// --- RLM Engine Types ---

export interface BlockResult {
  code: string
  metadata: string
  error?: string
}

export interface IterationRecord {
  number: number
  blocks: BlockResult[]
  timestamp: number
  durationMs: number
  oneLinerSummary: string
  fullMetadata: string
  pageChanges?: TabChange[]
}

export interface ResultMeta {
  type: string
  size: number
  preview: string
  schema?: string
  truncated?: boolean
  originalLength?: number
}

export interface TaskState {
  userMessage: string
  iteration: number
  maxIterations: number
  status: 'idle' | 'running' | 'complete' | 'cancelled' | 'error'
  iterations: IterationRecord[]
}

// --- LLM Config ---

export type LLMProvider = 'anthropic' | 'openai'

export interface LLMConfig {
  provider: LLMProvider
  apiKey: string
  baseURL?: string
  primaryModel: string
  subModel: string
  maxIterations: number
  maxSubCalls: number
}

// --- IPC Payload Types ---

export interface SubmitTaskPayload {
  message: string
}

export interface IterationStartPayload {
  iteration: number
  taskGoal: string
}

export interface StreamTokenPayload {
  token: string
  iteration: number
}

export interface CodeGeneratedPayload {
  code: string
  blockIndex: number
}

export interface CodeResultPayload {
  metadata: string
  blockIndex: number
  error?: string
}

export interface SubLLMStartPayload {
  prompt: string
}

export interface SubLLMCompletePayload {
  resultMeta: string
}

export interface PageChangesPayload {
  changes: TabChange[]
}

export interface LogPayload {
  message: string
}

export interface ErrorPayload {
  error: string
}

export interface CompletePayload {
  final: unknown
}

export interface EnvUpdatePayload {
  metadata: string
}

export interface ConfirmationReqPayload {
  action: string
  details: Record<string, unknown>
}

export interface ConfirmationRespPayload {
  approved: boolean
}

export interface NavigatePayload {
  tabId: string
  url: string
}

export interface TabActionPayload {
  tabId: string
}

export interface SettingsPayload {
  config: LLMConfig
}
