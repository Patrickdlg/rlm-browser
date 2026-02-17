import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // Tab management
  openTab: (url?: string) => ipcRenderer.invoke('tab:open', url),
  closeTab: (tabId: string) => ipcRenderer.invoke('tab:close', tabId),
  switchTab: (tabId: string) => ipcRenderer.invoke('tab:switch', tabId),
  navigate: (tabId: string, url: string) => ipcRenderer.invoke('tab:navigate', { tabId, url }),
  goBack: (tabId: string) => ipcRenderer.invoke('tab:go-back', tabId),
  goForward: (tabId: string) => ipcRenderer.invoke('tab:go-forward', tabId),
  reload: (tabId: string) => ipcRenderer.invoke('tab:reload', tabId),
  getAllTabs: () => ipcRenderer.invoke('tab:get-all'),
  getActiveTab: () => ipcRenderer.invoke('tab:get-active'),

  // Events from main
  onTabUpdated: (cb: (tab: any) => void) => {
    const handler = (_: any, tab: any) => cb(tab)
    ipcRenderer.on('tab:updated', handler)
    return () => ipcRenderer.removeListener('tab:updated', handler)
  },
  onActiveTabChanged: (cb: (tabId: string) => void) => {
    const handler = (_: any, tabId: string) => cb(tabId)
    ipcRenderer.on('tab:active-changed', handler)
    return () => ipcRenderer.removeListener('tab:active-changed', handler)
  },
  onTabClosed: (cb: (tabId: string) => void) => {
    const handler = (_: any, tabId: string) => cb(tabId)
    ipcRenderer.on('tab:closed', handler)
    return () => ipcRenderer.removeListener('tab:closed', handler)
  },
})
