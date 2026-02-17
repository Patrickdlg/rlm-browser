import { ipcMain, WebContentsView } from 'electron'
import { IPC } from '../../../src/shared/ipc-channels'
import type { TabManager } from '../tabs/TabManager'
import type { NavigatePayload, SubmitTaskPayload, ConfirmationRespPayload, LLMConfig } from '../../../src/shared/types'
import { RLMEngine } from '../rlm/engine'
import { getSettings, setSettings } from '../store/persistent'

let rlmEngine: RLMEngine | null = null

export function registerIPCHandlers(tabManager: TabManager, commandCenterView: WebContentsView): void {
  // Helper to ensure engine is initialized
  function ensureEngine(config: LLMConfig): RLMEngine {
    if (!rlmEngine) {
      rlmEngine = new RLMEngine(tabManager, commandCenterView, config)
    } else {
      rlmEngine.updateConfig(config)
    }
    return rlmEngine
  }

  // --- Tab handlers ---

  ipcMain.handle(IPC.TAB_OPEN, (_event, url?: string) => {
    return tabManager.openTab(url)
  })

  ipcMain.handle(IPC.TAB_CLOSE, (_event, tabId: string) => {
    tabManager.closeTab(tabId)
  })

  ipcMain.handle(IPC.TAB_SWITCH, (_event, tabId: string) => {
    tabManager.switchTab(tabId)
  })

  ipcMain.handle(IPC.TAB_NAVIGATE, (_event, payload: NavigatePayload) => {
    tabManager.navigate(payload.tabId, payload.url)
  })

  ipcMain.handle(IPC.TAB_GO_BACK, (_event, tabId: string) => {
    tabManager.goBack(tabId)
  })

  ipcMain.handle(IPC.TAB_GO_FORWARD, (_event, tabId: string) => {
    tabManager.goForward(tabId)
  })

  ipcMain.handle(IPC.TAB_RELOAD, (_event, tabId: string) => {
    tabManager.reload(tabId)
  })

  ipcMain.handle(IPC.TAB_GET_ALL, () => {
    return tabManager.getAllTabs()
  })

  ipcMain.handle(IPC.TAB_GET_ACTIVE, () => {
    return tabManager.getActiveTabId()
  })

  // --- RLM handlers ---

  ipcMain.handle(IPC.RLM_SUBMIT_TASK, async (_event, payload: SubmitTaskPayload) => {
    const config = getSettings()
    if (!config || !config.apiKey) {
      commandCenterView.webContents.send(IPC.RLM_ERROR, {
        error: 'LLM not configured. Open Settings and enter your API key.'
      })
      return
    }

    const engine = ensureEngine(config)
    try {
      await engine.runTask(payload.message)
    } catch (err: any) {
      commandCenterView.webContents.send(IPC.RLM_ERROR, { error: err.message || String(err) })
    }
  })

  ipcMain.handle(IPC.RLM_CANCEL, () => {
    if (rlmEngine) {
      rlmEngine.cancel()
    }
  })

  ipcMain.handle(IPC.RLM_GET_STATE, () => {
    if (rlmEngine) {
      return rlmEngine.getState()
    }
    return { status: 'idle', iterations: [] }
  })

  ipcMain.handle(IPC.RLM_CONFIRMATION_RESP, (_event, payload: ConfirmationRespPayload) => {
    if (rlmEngine) {
      rlmEngine.resolveConfirmation(payload.approved)
    }
  })

  // --- Settings handlers ---

  ipcMain.handle(IPC.SETTINGS_GET, () => {
    const config = getSettings()
    if (config) {
      // Mask API key for display
      return {
        ...config,
        apiKey: config.apiKey ? config.apiKey.slice(0, 8) + '...' + config.apiKey.slice(-4) : '',
      }
    }
    return null
  })

  ipcMain.handle(IPC.SETTINGS_SET, (_event, config: LLMConfig) => {
    setSettings(config)
    // Update or create engine with new config
    ensureEngine(config)
    return { success: true }
  })
}
