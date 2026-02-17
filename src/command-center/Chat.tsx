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
    <div className="border-t border-[#313244] p-3">
      <div className="flex gap-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isRunning ? 'Task running...' : 'Ask the RLM to do something...'}
          disabled={isRunning}
          rows={2}
          className="flex-1 bg-[#1e1e2e] text-[#cdd6f4] text-sm px-3 py-2 rounded-lg border border-[#313244]
            focus:border-[#89b4fa] focus:outline-none resize-none
            placeholder:text-[#6c7086] disabled:opacity-50"
        />
        <div className="flex flex-col gap-1">
          {isRunning ? (
            <button
              onClick={onCancel}
              className="px-3 py-2 bg-[#f38ba8] text-[#11111b] rounded-lg text-xs font-medium hover:bg-[#eba0ac]"
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
              className="px-3 py-2 bg-[#89b4fa] text-[#11111b] rounded-lg text-xs font-medium
                hover:bg-[#b4d0fb] disabled:opacity-30 disabled:cursor-default"
            >
              Run
            </button>
          )}
        </div>
      </div>
      <p className="text-[10px] text-[#45475a] mt-1">
        Enter to submit, Shift+Enter for newline
      </p>
    </div>
  )
}
