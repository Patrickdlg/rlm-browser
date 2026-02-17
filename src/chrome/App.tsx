import { useState, useEffect, useCallback } from 'react'
import type { TabInfo } from '../shared/types'
import TabBar from './TabBar'
import AddressBar from './AddressBar'
import NavigationControls from './NavigationControls'

declare global {
  interface Window {
    electronAPI: {
      openTab: (url?: string) => Promise<string>
      closeTab: (tabId: string) => Promise<void>
      switchTab: (tabId: string) => Promise<void>
      navigate: (tabId: string, url: string) => Promise<void>
      goBack: (tabId: string) => Promise<void>
      goForward: (tabId: string) => Promise<void>
      reload: (tabId: string) => Promise<void>
      getAllTabs: () => Promise<TabInfo[]>
      getActiveTab: () => Promise<string | null>
      toggleCommandCenter: () => Promise<boolean>
      isCommandCenter: () => Promise<boolean>
      onTabUpdated: (cb: (tab: TabInfo) => void) => () => void
      onActiveTabChanged: (cb: (tabId: string) => void) => () => void
      onTabClosed: (cb: (tabId: string) => void) => () => void
    }
  }
}

export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [commandCenterActive, setCommandCenterActive] = useState(false)

  const activeTab = tabs.find(t => t.id === activeTabId) ?? null

  useEffect(() => {
    window.electronAPI.getAllTabs().then(setTabs)
    window.electronAPI.getActiveTab().then(setActiveTabId)
    window.electronAPI.isCommandCenter().then(setCommandCenterActive)

    const unsubs = [
      window.electronAPI.onTabUpdated((tab) => {
        setTabs(prev => {
          const idx = prev.findIndex(t => t.id === tab.id)
          if (idx >= 0) {
            const next = [...prev]
            next[idx] = tab
            return next
          }
          return [...prev, tab]
        })
      }),
      window.electronAPI.onActiveTabChanged((tabId) => {
        setActiveTabId(tabId)
      }),
      window.electronAPI.onTabClosed((tabId) => {
        setTabs(prev => prev.filter(t => t.id !== tabId))
      }),
    ]

    return () => unsubs.forEach(fn => fn())
  }, [])

  const handleNewTab = useCallback(() => {
    window.electronAPI.openTab()
  }, [])

  const handleCloseTab = useCallback((tabId: string) => {
    window.electronAPI.closeTab(tabId)
  }, [])

  const handleSwitchTab = useCallback((tabId: string) => {
    // If command center is showing, switch back to tabs first
    if (commandCenterActive) {
      window.electronAPI.toggleCommandCenter().then(setCommandCenterActive)
    }
    window.electronAPI.switchTab(tabId)
  }, [commandCenterActive])

  const handleNavigate = useCallback((url: string) => {
    if (!activeTabId) return
    let finalUrl = url.trim()
    if (finalUrl && !finalUrl.match(/^[a-zA-Z]+:\/\//)) {
      if (finalUrl.includes('.') && !finalUrl.includes(' ')) {
        finalUrl = 'https://' + finalUrl
      } else {
        finalUrl = `https://www.google.com/search?q=${encodeURIComponent(finalUrl)}`
      }
    }
    window.electronAPI.navigate(activeTabId, finalUrl)
  }, [activeTabId])

  const handleGoBack = useCallback(() => {
    if (activeTabId) window.electronAPI.goBack(activeTabId)
  }, [activeTabId])

  const handleGoForward = useCallback(() => {
    if (activeTabId) window.electronAPI.goForward(activeTabId)
  }, [activeTabId])

  const handleReload = useCallback(() => {
    if (activeTabId) window.electronAPI.reload(activeTabId)
  }, [activeTabId])

  const handleToggleCommandCenter = useCallback(() => {
    window.electronAPI.toggleCommandCenter().then(setCommandCenterActive)
  }, [])

  return (
    <div className="flex flex-col h-screen bg-[#1e1e2e]">
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        commandCenterActive={commandCenterActive}
        onSwitch={handleSwitchTab}
        onClose={handleCloseTab}
        onNew={handleNewTab}
        onToggleCommandCenter={handleToggleCommandCenter}
      />
      <div className="flex items-center gap-2 py-1.5 bg-[#181825] border-b border-[#313244]" style={{ paddingLeft: 8, paddingRight: 8 }}>
        <NavigationControls
          canGoBack={activeTab?.canGoBack ?? false}
          canGoForward={activeTab?.canGoForward ?? false}
          isLoading={activeTab?.status === 'loading'}
          onBack={handleGoBack}
          onForward={handleGoForward}
          onReload={handleReload}
        />
        <AddressBar
          url={commandCenterActive ? '' : (activeTab?.url ?? '')}
          onNavigate={handleNavigate}
          disabled={commandCenterActive}
          placeholder={commandCenterActive ? 'Command Center' : undefined}
        />
      </div>
    </div>
  )
}
