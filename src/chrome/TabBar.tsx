import type { TabInfo } from '../shared/types'

interface TabBarProps {
  tabs: TabInfo[]
  activeTabId: string | null
  commandCenterActive: boolean
  onSwitch: (tabId: string) => void
  onClose: (tabId: string) => void
  onNew: () => void
  onToggleCommandCenter: () => void
}

const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

export default function TabBar({
  tabs, activeTabId, commandCenterActive,
  onSwitch, onClose, onNew, onToggleCommandCenter
}: TabBarProps) {
  return (
    <div
      className="flex items-stretch bg-[#11111b] overflow-x-auto flex-shrink-0"
      style={{ paddingLeft: 80, paddingRight: 8, paddingTop: 8, WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {tabs.map((tab, i) => {
        const isActive = tab.id === activeTabId && !commandCenterActive
        const prevActive = i > 0 && tabs[i - 1].id === activeTabId && !commandCenterActive
        const showSep = !isActive && !prevActive && i > 0

        return (
          <div key={tab.id} className="flex items-stretch">
            {/* Separator between inactive tabs */}
            {showSep && (
              <div className="flex items-center" style={{ width: 1 }}>
                <div className="h-4 bg-[#45475a]/50 w-full" />
              </div>
            )}
            <div
              onClick={() => onSwitch(tab.id)}
              style={noDrag}
              className={`
                flex items-center gap-2.5 pl-3.5 pr-2.5 rounded-t-lg min-w-[150px] max-w-[240px] cursor-pointer
                text-[13px] transition-colors
                ${isActive
                  ? 'bg-[#181825] text-[#cdd6f4]'
                  : 'text-[#6c7086] hover:bg-[#181825]/50'
                }
              `}
            >
              {tab.favicon ? (
                <img src={tab.favicon} className="w-4 h-4 flex-shrink-0" alt="" />
              ) : (
                <div className="w-4 h-4 flex-shrink-0 rounded-full bg-[#45475a]" />
              )}
              <span className="truncate flex-1">
                {tab.title || (tab.status === 'loading' ? 'Loading...' : 'New Tab')}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); onClose(tab.id) }}
                style={noDrag}
                className="w-5 h-5 flex items-center justify-center rounded-sm hover:bg-[#45475a] text-[#585b70] hover:text-[#cdd6f4] flex-shrink-0 text-xs"
              >
                ✕
              </button>
            </div>
          </div>
        )
      })}
      <button
        onClick={onNew}
        style={noDrag}
        className="flex items-center justify-center w-8 self-center rounded hover:bg-[#313244] text-[#6c7086] hover:text-[#cdd6f4] flex-shrink-0 ml-1 text-lg"
      >
        +
      </button>

      {/* Spacer pushes command center toggle to the right */}
      <div className="flex-1 min-w-[20px]" />

      {/* Command Center toggle */}
      <button
        onClick={onToggleCommandCenter}
        style={noDrag}
        className={`
          flex items-center gap-1.5 px-4 rounded-t-lg cursor-pointer text-[13px] font-medium transition-colors flex-shrink-0
          ${commandCenterActive
            ? 'bg-[#181825] text-[#89b4fa]'
            : 'text-[#6c7086] hover:bg-[#181825]/50 hover:text-[#89b4fa]'
          }
        `}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 3v18" />
          <path d="M14 9l3 3-3 3" />
        </svg>
        RLM
      </button>
    </div>
  )
}
