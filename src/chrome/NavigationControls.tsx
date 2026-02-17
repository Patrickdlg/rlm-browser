interface NavigationControlsProps {
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  onBack: () => void
  onForward: () => void
  onReload: () => void
}

export default function NavigationControls({
  canGoBack, canGoForward, isLoading,
  onBack, onForward, onReload
}: NavigationControlsProps) {
  const btnClass = (enabled: boolean) =>
    `w-7 h-7 flex items-center justify-center rounded text-sm
    ${enabled
      ? 'text-[#cdd6f4] hover:bg-[#313244] cursor-pointer'
      : 'text-[#45475a] cursor-default'
    }`

  return (
    <div className="flex items-center gap-0.5">
      <button className={btnClass(canGoBack)} onClick={onBack} disabled={!canGoBack}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <button className={btnClass(canGoForward)} onClick={onForward} disabled={!canGoForward}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
      <button className={btnClass(true)} onClick={onReload}>
        {isLoading ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        )}
      </button>
    </div>
  )
}
