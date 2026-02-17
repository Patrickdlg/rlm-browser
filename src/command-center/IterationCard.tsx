import { useState } from 'react'
import type { IterationState } from './App'

interface IterationCardProps {
  iteration: IterationState
  isActive: boolean
  streamTokens?: string
}

export default function IterationCard({ iteration, isActive, streamTokens }: IterationCardProps) {
  const [expanded, setExpanded] = useState(isActive)
  const [logsExpanded, setLogsExpanded] = useState(false)

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
        {iteration.logs.length > 0 && (
          <span className="text-[10px] text-[#6c7086]">({iteration.logs.length} log{iteration.logs.length !== 1 ? 's' : ''})</span>
        )}
        <span className="text-[#6c7086] ml-auto">{duration}</span>
        <span className="text-[#45475a]">{expanded ? 'v' : '>'}</span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-2 space-y-2">
          {/* Streaming tokens — only show while active AND before any code blocks arrive */}
          {isActive && streamTokens && iteration.codeBlocks.length === 0 && (
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

          {/* Logs — collapsible */}
          {iteration.logs.length > 0 && (
            <div className="border border-[#313244]/50 rounded overflow-hidden">
              <button
                onClick={(e) => { e.stopPropagation(); setLogsExpanded(!logsExpanded) }}
                className="w-full flex items-center gap-2 px-2 py-1 text-[10px] text-[#6c7086] hover:bg-[#1e1e2e] text-left"
              >
                <span>{logsExpanded ? 'v' : '>'}</span>
                <span>Logs ({iteration.logs.length})</span>
              </button>
              {logsExpanded && (
                <div className="px-2 pb-1.5 max-h-40 overflow-y-auto">
                  {iteration.logs.map((log, i) => (
                    <div key={i} className="text-[10px] text-[#a6adc8] font-mono py-0.5 break-words">
                      {log.message}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
