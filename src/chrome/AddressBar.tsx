import { useState, useEffect, useRef } from 'react'

interface AddressBarProps {
  url: string
  onNavigate: (url: string) => void
  disabled?: boolean
  placeholder?: string
}

export default function AddressBar({ url, onNavigate, disabled, placeholder }: AddressBarProps) {
  const [inputValue, setInputValue] = useState(url)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync external URL changes when not focused
  useEffect(() => {
    if (!focused) {
      setInputValue(url)
    }
  }, [url, focused])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onNavigate(inputValue)
      inputRef.current?.blur()
    } else if (e.key === 'Escape') {
      setInputValue(url)
      inputRef.current?.blur()
    }
  }

  const handleFocus = () => {
    setFocused(true)
    // Select all on focus
    setTimeout(() => inputRef.current?.select(), 0)
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={inputValue}
      onChange={(e) => setInputValue(e.target.value)}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      onBlur={() => setFocused(false)}
      disabled={disabled}
      placeholder={placeholder || 'Search or enter URL'}
      className="flex-1 h-7 px-3 rounded-md bg-[#313244] text-[#cdd6f4] text-sm
        border border-transparent focus:border-[#89b4fa] focus:outline-none
        placeholder:text-[#6c7086] disabled:opacity-50"
    />
  )
}
