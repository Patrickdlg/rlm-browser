import { useState } from 'react'
import type { IterationState } from './App'

interface IterationCardProps {
  iteration: IterationState
  isActive: boolean
  streamTokens?: string
}

export default function IterationCard({ iteration, isActive, streamTokens }: IterationCardProps) {
  const [expanded, setExpanded] = useState(isActive)

  const statusIcon = iteration.complete
    ? iteration.codeBlocks.some(b => b.error) ? '!' : 'ok'
    : isActive ? '..' : '-'

  const statusColor = iteration.complete
    ? iteration.codeBlocks.some(b => b.error) ? 'text-[#fab387]' : 'text-[#a6e3a1]'
    : isActive ? 'text-[#89b4fa]' : 'text-[#6c7086]'

  const duration = iteration.durationMs
    ? `${(iteration.durationMs / 1000).toFixed(1)}s`
    : isActive ? '...' : ''

  return (
    <div className="border border-[#313244] rounded-lg mb-1.5 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[#1e1e2e] text-left"
      >
        <span className={`font-mono font-bold ${statusColor}`}>{statusIcon}</span>
        <span className="font-medium">Iteration {iteration.number}</span>
        <span className="text-[#6c7086] ml-auto">{duration}</span>
        <span className="text-[#45475a]">{expanded ? 'v' : '>'}</span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-2 space-y-2">
          {/* Streaming tokens (while active) */}
          {isActive && streamTokens && (
            <div className="bg-[#181825] rounded p-2 text-xs">
              <pre className="whitespace-pre-wrap font-mono text-[#a6adc8] max-h-40 overflow-y-auto">
                {streamTokens}
                <span className="animate-pulse text-[#89b4fa]">|</span>
              </pre>
            </div>
          )}

          {/* Code blocks + results */}
          {iteration.codeBlocks.map((block, i) => (
            <div key={i} className="space-y-1">
              <div className="bg-[#1e1e2e] rounded p-2">
                <div className="text-[10px] text-[#6c7086] mb-1">Code{iteration.codeBlocks.length > 1 ? ` (block ${i + 1})` : ''}:</div>
                <pre className="text-xs font-mono text-[#cba6f7] whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {block.code}
                </pre>
              </div>
              {block.result && (
                <div className={`rounded p-2 text-xs ${block.error ? 'bg-[#2a1520]' : 'bg-[#151520]'}`}>
                  <div className={`text-[10px] mb-1 ${block.error ? 'text-[#f38ba8]' : 'text-[#6c7086]'}`}>
                    {block.error ? 'Error:' : 'Result:'}
                  </div>
                  <pre className={`font-mono whitespace-pre-wrap max-h-32 overflow-y-auto ${
                    block.error ? 'text-[#f38ba8]' : 'text-[#a6e3a1]'
                  }`}>
                    {block.result}
                  </pre>
                </div>
              )}
            </div>
          ))}

          {/* Sub-LLM calls */}
          {iteration.subCalls.map((sub, i) => (
            <div key={`sub-${i}`} className="bg-[#151525] rounded p-2 text-xs">
              <div className="text-[10px] text-[#89b4fa] mb-1">
                Sub-LLM Call {sub.result ? '(complete)' : '(running...)'}
              </div>
              <div className="text-[#a6adc8] font-mono truncate">{sub.prompt}</div>
              {sub.result && (
                <div className="text-[#a6e3a1] font-mono mt-1 truncate">{sub.result}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
