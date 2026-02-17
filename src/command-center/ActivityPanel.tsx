import { useRef, useEffect } from 'react'
import type { IterationState } from './App'
import IterationCard from './IterationCard'

interface ActivityPanelProps {
  iterations: IterationState[]
  streamTokens: string
  currentIteration: number
  isRunning: boolean
  logs: Array<{ message: string; timestamp: number }>
  errors: string[]
}

export default function ActivityPanel({
  iterations, streamTokens, currentIteration, isRunning, logs, errors
}: ActivityPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [iterations, logs, errors, streamTokens])

  if (iterations.length === 0 && logs.length === 0 && errors.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[#45475a] text-sm">
        <div className="text-center">
          <p>No activity yet.</p>
          <p className="text-xs mt-1">Submit a task to begin.</p>
        </div>
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="p-3 space-y-2">
      {/* Errors */}
      {errors.map((err, i) => (
        <div key={`err-${i}`} className="bg-[#2a1520] border border-[#f38ba8]/30 rounded-lg px-3 py-2 text-xs text-[#f38ba8]">
          {err}
        </div>
      ))}

      {/* Iterations */}
      {iterations.map((iter, i) => (
        <IterationCard
          key={iter.number}
          iteration={iter}
          isActive={isRunning && i === iterations.length - 1}
          streamTokens={isRunning && i === iterations.length - 1 ? streamTokens : undefined}
        />
      ))}

      {/* Logs */}
      {logs.length > 0 && (
        <div className="space-y-0.5">
          {logs.map((log, i) => (
            <div key={`log-${i}`} className="text-xs text-[#a6adc8] px-2 py-0.5 font-mono">
              {log.message}
            </div>
          ))}
        </div>
      )}

      {/* Running indicator */}
      {isRunning && iterations.length === 0 && (
        <div className="text-xs text-[#89b4fa] px-2 animate-pulse">
          Starting RLM loop...
        </div>
      )}
    </div>
  )
}
