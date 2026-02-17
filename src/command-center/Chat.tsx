import { useState, useRef, useEffect } from 'react'

interface ChatProps {
  onSubmit: (message: string) => void
  onCancel: () => void
  isRunning: boolean
}

export default function Chat({ onSubmit, onCancel, isRunning }: ChatProps) {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (input.trim() && !isRunning) {
        onSubmit(input.trim())
        setInput('')
      }
    }
  }

  return (
    <div className="border-t border-[#313244]" style={{ padding: '16px 24px' }}>
      <div className="flex items-center gap-3">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isRunning ? 'Task running...' : 'Ask the RLM to do something...'}
          disabled={isRunning}
          rows={2}
          className="flex-1 bg-[#1e1e2e] text-[#cdd6f4] text-sm rounded-lg border border-[#313244]
            focus:border-[#89b4fa] focus:outline-none resize-none
            placeholder:text-[#6c7086] disabled:opacity-50"
          style={{ padding: '10px 14px' }}
        />
        {isRunning ? (
          <button
            onClick={onCancel}
            className="bg-[#f38ba8] text-[#11111b] rounded-lg text-sm font-medium hover:bg-[#eba0ac]"
            style={{ padding: '10px 20px', flexShrink: 0 }}
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={() => {
              if (input.trim()) {
                onSubmit(input.trim())
                setInput('')
              }
            }}
            disabled={!input.trim()}
            className="bg-[#89b4fa] text-[#11111b] rounded-lg text-sm font-medium
              hover:bg-[#b4d0fb] disabled:opacity-30 disabled:cursor-default"
            style={{ padding: '10px 20px', flexShrink: 0 }}
          >
            Run
          </button>
        )}
      </div>
      <p className="text-[#45475a]" style={{ fontSize: 10, marginTop: 6 }}>
        Enter to submit, Shift+Enter for newline
      </p>
    </div>
  )
}
