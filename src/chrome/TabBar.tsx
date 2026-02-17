import type { TabInfo } from '../shared/types'

interface TabBarProps {
  tabs: TabInfo[]
  activeTabId: string | null
  onSwitch: (tabId: string) => void
  onClose: (tabId: string) => void
  onNew: () => void
}

export default function TabBar({ tabs, activeTabId, onSwitch, onClose, onNew }: TabBarProps) {
  return (
    <div className="flex items-end h-9 bg-[#11111b] px-1 pt-1 gap-0.5 overflow-x-auto">
      {tabs.map(tab => (
        <div
          key={tab.id}
          onClick={() => onSwitch(tab.id)}
          className={`
            flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg min-w-[120px] max-w-[200px] cursor-pointer
            text-xs transition-colors
            ${tab.id === activeTabId
              ? 'bg-[#1e1e2e] text-[#cdd6f4]'
              : 'bg-[#181825] text-[#6c7086] hover:bg-[#1e1e2e]/50'
            }
          `}
        >
          {tab.favicon ? (
            <img src={tab.favicon} className="w-3.5 h-3.5 flex-shrink-0" alt="" />
          ) : (
            <div className="w-3.5 h-3.5 flex-shrink-0 rounded-full bg-[#45475a]" />
          )}
          <span className="truncate flex-1">
            {tab.status === 'loading' ? 'Loading...' : (tab.title || 'New Tab')}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); onClose(tab.id) }}
            className="w-4 h-4 flex items-center justify-center rounded hover:bg-[#45475a] text-[#6c7086] hover:text-[#cdd6f4] flex-shrink-0"
          >
            x
          </button>
        </div>
      ))}
      <button
        onClick={onNew}
        className="flex items-center justify-center w-7 h-7 rounded hover:bg-[#313244] text-[#6c7086] hover:text-[#cdd6f4] flex-shrink-0 ml-0.5"
      >
        +
      </button>
    </div>
  )
}
