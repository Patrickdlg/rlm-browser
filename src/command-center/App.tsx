import { useState, useEffect, useRef } from 'react'
import Chat from './Chat'
import ActivityPanel from './ActivityPanel'
import OutputPanel from './OutputPanel'
import Settings from './Settings'

declare global {
  interface Window {
    electronAPI: {
      submitTask: (message: string) => Promise<void>
      cancelTask: () => Promise<void>
      getState: () => Promise<any>
      confirmationResponse: (approved: boolean) => Promise<void>
      getSettings: () => Promise<any>
      setSettings: (config: any) => Promise<any>
      onIterationStart: (cb: (data: any) => void) => () => void
      onStreamToken: (cb: (data: any) => void) => () => void
      onCodeGenerated: (cb: (data: any) => void) => () => void
      onCodeResult: (cb: (data: any) => void) => () => void
      onSubLLMStart: (cb: (data: any) => void) => () => void
      onSubLLMComplete: (cb: (data: any) => void) => () => void
      onPageChanges: (cb: (data: any) => void) => () => void
      onLog: (cb: (data: any) => void) => () => void
      onError: (cb: (data: any) => void) => () => void
      onComplete: (cb: (data: any) => void) => () => void
      onEnvUpdate: (cb: (data: any) => void) => () => void
      onConfirmationReq: (cb: (data: any) => void) => () => void
    }
  }
}

export interface ActivityEntry {
  id: string
  type: 'iteration-start' | 'token' | 'code' | 'result' | 'sub-llm-start' | 'sub-llm-complete' | 'page-change' | 'log' | 'error' | 'complete'
  data: any
  timestamp: number
}

export interface IterationState {
  number: number
  tokens: string
  codeBlocks: Array<{ code: string; result?: string; error?: string }>
  subCalls: Array<{ prompt: string; result?: string }>
  complete: boolean
  durationMs?: number
}

export default function App() {
  const [showSettings, setShowSettings] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [iterations, setIterations] = useState<IterationState[]>([])
  const [logs, setLogs] = useState<Array<{ message: string; timestamp: number }>>([])
  const [finalResult, setFinalResult] = useState<any>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [streamTokens, setStreamTokens] = useState('')
  const [currentIteration, setCurrentIteration] = useState(0)

  const iterStartTime = useRef<number>(0)

  useEffect(() => {
    const unsubs = [
      window.electronAPI.onIterationStart((data) => {
        setCurrentIteration(data.iteration)
        setStreamTokens('')
        iterStartTime.current = Date.now()
        setIterations(prev => [...prev, {
          number: data.iteration,
          tokens: '',
          codeBlocks: [],
          subCalls: [],
          complete: false,
        }])
      }),

      window.electronAPI.onStreamToken((data) => {
        setStreamTokens(prev => prev + data.token)
        setIterations(prev => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last) last.tokens += data.token
          return next
        })
      }),

      window.electronAPI.onCodeGenerated((data) => {
        setIterations(prev => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last) {
            last.codeBlocks.push({ code: data.code })
          }
          return next
        })
      }),

      window.electronAPI.onCodeResult((data) => {
        setIterations(prev => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last && last.codeBlocks.length > 0) {
            const block = last.codeBlocks[data.blockIndex] || last.codeBlocks[last.codeBlocks.length - 1]
            if (block) {
              block.result = data.metadata
              block.error = data.error
            }
          }
          return next
        })
      }),

      window.electronAPI.onSubLLMStart((data) => {
        setIterations(prev => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last) last.subCalls.push({ prompt: data.prompt })
          return next
        })
      }),

      window.electronAPI.onSubLLMComplete((data) => {
        setIterations(prev => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last && last.subCalls.length > 0) {
            last.subCalls[last.subCalls.length - 1].result = data.resultMeta
          }
          return next
        })
      }),

      window.electronAPI.onLog((data) => {
        setLogs(prev => [...prev, { message: data.message, timestamp: Date.now() }])
      }),

      window.electronAPI.onError((data) => {
        setErrors(prev => [...prev, data.error])
      }),

      window.electronAPI.onComplete((data) => {
        setIsRunning(false)
        setFinalResult(data.final)
        setStreamTokens('')
        setIterations(prev => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last) {
            last.complete = true
            last.durationMs = Date.now() - iterStartTime.current
          }
          return next
        })
      }),
    ]

    return () => unsubs.forEach(fn => fn())
  }, [])

  const handleSubmit = async (message: string) => {
    setIsRunning(true)
    setIterations([])
    setLogs([])
    setFinalResult(null)
    setErrors([])
    setStreamTokens('')
    setCurrentIteration(0)
    await window.electronAPI.submitTask(message)
  }

  const handleCancel = async () => {
    await window.electronAPI.cancelTask()
  }

  if (showSettings) {
    return <Settings onClose={() => setShowSettings(false)} />
  }

  return (
    <div className="flex flex-col h-screen bg-[#11111b] text-[#cdd6f4]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#313244]" style={{ padding: '12px 24px' }}>
        <h1 className="text-sm font-semibold text-[#89b4fa]">Command Center</h1>
        <button
          onClick={() => setShowSettings(true)}
          className="text-xs text-[#6c7086] hover:text-[#cdd6f4] px-2 py-1 rounded hover:bg-[#313244]"
        >
          Settings
        </button>
      </div>

      {/* Activity Panel */}
      <div className="flex-1 overflow-y-auto">
        <ActivityPanel
          iterations={iterations}
          streamTokens={streamTokens}
          currentIteration={currentIteration}
          isRunning={isRunning}
          logs={logs}
          errors={errors}
        />

        {/* Output Panel */}
        {finalResult !== null && (
          <OutputPanel result={finalResult} />
        )}
      </div>

      {/* Chat Input */}
      <Chat
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        isRunning={isRunning}
      />
    </div>
  )
}
