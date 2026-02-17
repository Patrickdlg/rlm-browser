import { useState } from 'react'

interface OutputPanelProps {
  result: unknown
}

export default function OutputPanel({ result }: OutputPanelProps) {
  const [expanded, setExpanded] = useState(true)

  const formatted = typeof result === 'string' ? result : JSON.stringify(result, null, 2)

  return (
    <div className="mx-3 mb-3 border border-[#a6e3a1]/30 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-[#1a2520] text-xs hover:bg-[#1e2e25]"
      >
        <span className="text-[#a6e3a1] font-bold">Result</span>
        <span className="text-[#6c7086] ml-auto">{expanded ? 'v' : '>'}</span>
      </button>
      {expanded && (
        <div className="bg-[#151520] p-3 max-h-80 overflow-y-auto">
          <pre className="text-sm font-mono text-[#cdd6f4] whitespace-pre-wrap">
            {formatted}
          </pre>
        </div>
      )}
    </div>
  )
}
