import { BaseWindow, WebContentsView } from 'electron'
import { TabState } from './TabState'
import { TabDiffer } from './TabDiffer'
import type { TabInfo, TabChange } from '../../../src/shared/types'
import { IPC } from '../../../src/shared/ipc-channels'

let tabCounter = 0
function nextTabId(): string {
  return `tab_${tabCounter++}`
}

export class TabManager {
  private window: BaseWindow
  private getTabBounds: () => { x: number; y: number; width: number; height: number }
  private tabs: Map<string, { state: TabState; view: WebContentsView }> = new Map()
  private activeTabId: string | null = null
  private chromeView: WebContentsView | null = null
  private differ = new TabDiffer()

  constructor(
    window: BaseWindow,
    getTabBounds: () => { x: number; y: number; width: number; height: number }
  ) {
    this.window = window
    this.getTabBounds = getTabBounds
  }

  setChromeView(view: WebContentsView): void {
    this.chromeView = view
  }

  private notifyChrome(channel: string, data: unknown): void {
    if (this.chromeView && !this.chromeView.webContents.isDestroyed()) {
      this.chromeView.webContents.send(channel, data)
    }
  }

  openTab(url?: string): string {
    const id = nextTabId()
    const state = new TabState(id)

    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        // No preload — user tabs are fully sandboxed
      },
    })

    this.tabs.set(id, { state, view })

    // Attach webContents event listeners
    const wc = view.webContents

    wc.on('did-start-loading', () => {
      state.status = 'loading'
      this.notifyChrome(IPC.TAB_UPDATED, state.toInfo())
    })

    wc.on('did-finish-load', () => {
      state.status = 'loaded'
      state.canGoBack = wc.navigationHistory.canGoBack()
      state.canGoForward = wc.navigationHistory.canGoForward()
      this.notifyChrome(IPC.TAB_UPDATED, state.toInfo())
    })

    wc.on('did-fail-load', (_event, errorCode, errorDescription) => {
      // Ignore aborted loads (e.g., navigating away before load finishes)
      if (errorCode === -3) return
      state.status = 'error'
      this.notifyChrome(IPC.TAB_UPDATED, state.toInfo())
    })

    wc.on('did-navigate', (_event, url) => {
      state.url = url
      state.canGoBack = wc.navigationHistory.canGoBack()
      state.canGoForward = wc.navigationHistory.canGoForward()
      this.notifyChrome(IPC.TAB_UPDATED, state.toInfo())
    })

    wc.on('did-navigate-in-page', (_event, url) => {
      state.url = url
      state.canGoBack = wc.navigationHistory.canGoBack()
      state.canGoForward = wc.navigationHistory.canGoForward()
      this.notifyChrome(IPC.TAB_UPDATED, state.toInfo())
    })

    wc.on('page-title-updated', (_event, title) => {
      state.title = title
      this.notifyChrome(IPC.TAB_UPDATED, state.toInfo())
    })

    wc.on('page-favicon-updated', (_event, favicons) => {
      if (favicons.length > 0) {
        state.favicon = favicons[0]
        this.notifyChrome(IPC.TAB_UPDATED, state.toInfo())
      }
    })

    // Handle new-window requests (e.g., target=_blank links)
    wc.setWindowOpenHandler(({ url }) => {
      this.openTab(url)
      return { action: 'deny' }
    })

    // Make this the active tab
    this.switchTab(id)

    // Navigate if URL provided
    if (url && url !== 'about:blank') {
      wc.loadURL(url)
      state.url = url
    }

    this.notifyChrome(IPC.TAB_UPDATED, state.toInfo())
    return id
  }

  closeTab(tabId: string): void {
    const entry = this.tabs.get(tabId)
    if (!entry) return

    // Remove the view from the window
    this.window.contentView.removeChildView(entry.view)
    entry.view.webContents.close()
    this.tabs.delete(tabId)

    this.notifyChrome(IPC.TAB_CLOSED, tabId)

    // If we closed the active tab, switch to the last remaining tab or null
    if (this.activeTabId === tabId) {
      const remaining = [...this.tabs.keys()]
      if (remaining.length > 0) {
        this.switchTab(remaining[remaining.length - 1])
      } else {
        this.activeTabId = null
        this.notifyChrome(IPC.TAB_ACTIVE_CHANGED, null)
      }
    }
  }

  switchTab(tabId: string): void {
    const entry = this.tabs.get(tabId)
    if (!entry) return

    // Move previous active tab off-screen
    if (this.activeTabId && this.activeTabId !== tabId) {
      const prev = this.tabs.get(this.activeTabId)
      if (prev) {
        this.window.contentView.removeChildView(prev.view)
      }
    }

    // Add and position new active tab
    this.window.contentView.addChildView(entry.view)
    this.activeTabId = tabId
    this.layoutActiveTab()

    this.notifyChrome(IPC.TAB_ACTIVE_CHANGED, tabId)
  }

  navigate(tabId: string, url: string): void {
    const entry = this.tabs.get(tabId)
    if (!entry) return
    entry.view.webContents.loadURL(url)
  }

  goBack(tabId: string): void {
    const entry = this.tabs.get(tabId)
    if (entry && entry.view.webContents.navigationHistory.canGoBack()) {
      entry.view.webContents.navigationHistory.goBack()
    }
  }

  goForward(tabId: string): void {
    const entry = this.tabs.get(tabId)
    if (entry && entry.view.webContents.navigationHistory.canGoForward()) {
      entry.view.webContents.navigationHistory.goForward()
    }
  }

  reload(tabId: string): void {
    const entry = this.tabs.get(tabId)
    if (entry) {
      entry.view.webContents.reload()
    }
  }

  layoutActiveTab(): void {
    if (!this.activeTabId) return
    const entry = this.tabs.get(this.activeTabId)
    if (!entry) return
    this.window.contentView.addChildView(entry.view)
    const bounds = this.getTabBounds()
    entry.view.setBounds(bounds)
  }

  /** Remove the active tab view from the window (for command center toggle) */
  hideActiveTab(): void {
    if (!this.activeTabId) return
    const entry = this.tabs.get(this.activeTabId)
    if (entry) {
      this.window.contentView.removeChildView(entry.view)
    }
  }

  getAllTabs(): TabInfo[] {
    return [...this.tabs.values()].map(e => e.state.toInfo())
  }

  getActiveTabId(): string | null {
    return this.activeTabId
  }

  getTabUrl(tabId: string): string | undefined {
    return this.tabs.get(tabId)?.state.url
  }

  // --- Methods for RLM engine ---

  /** Execute arbitrary JavaScript in a tab's renderer process */
  async exec(tabId: string, code: string): Promise<unknown> {
    const entry = this.tabs.get(tabId)
    if (!entry) throw new Error(`Tab ${tabId} not found`)
    return entry.view.webContents.executeJavaScript(code)
  }

  /** Wait for a tab to finish loading */
  async waitForLoad(tabId: string, timeout: number = 30000): Promise<void> {
    const entry = this.tabs.get(tabId)
    if (!entry) throw new Error(`Tab ${tabId} not found`)

    if (entry.state.status === 'loaded') return

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`waitForLoad timed out after ${timeout}ms for tab ${tabId}`))
      }, timeout)

      const onFinish = () => {
        cleanup()
        resolve()
      }

      const cleanup = () => {
        clearTimeout(timer)
        entry.view.webContents.removeListener('did-finish-load', onFinish)
        entry.view.webContents.removeListener('did-fail-load', onFinish)
      }

      entry.view.webContents.on('did-finish-load', onFinish)
      entry.view.webContents.on('did-fail-load', onFinish)
    })
  }

  // --- Diffing for RLM ---

  /** Snapshot all tab states for diffing */
  captureSnapshot(): void {
    const tabMap = new Map<string, { url: string; title: string; status: string }>()
    for (const [id, entry] of this.tabs) {
      tabMap.set(id, { url: entry.state.url, title: entry.state.title, status: entry.state.status })
    }
    this.differ.capture(tabMap)
  }

  /** Get changes since last snapshot */
  getChanges(): TabChange[] {
    const tabMap = new Map<string, { url: string; title: string; status: string }>()
    for (const [id, entry] of this.tabs) {
      tabMap.set(id, { url: entry.state.url, title: entry.state.title, status: entry.state.status })
    }
    return this.differ.diff(tabMap)
  }

  /** Destroy all tab views — call on app quit */
  destroyAll(): void {
    for (const [_id, entry] of this.tabs) {
      try {
        this.window.contentView.removeChildView(entry.view)
        entry.view.webContents.close()
      } catch {
        // View may already be destroyed
      }
    }
    this.tabs.clear()
    this.activeTabId = null
  }
}
