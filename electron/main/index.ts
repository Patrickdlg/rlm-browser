import { app, BaseWindow, WebContentsView, ipcMain } from 'electron'
import { join } from 'path'
import { TabManager } from './tabs/TabManager'
import { registerIPCHandlers } from './ipc/handlers'

// Layout constants
const CHROME_HEIGHT = 82

let mainWindow: BaseWindow
let chromeView: WebContentsView
let commandCenterView: WebContentsView
let tabManager: TabManager
let showingCommandCenter = false

function createWindow() {
  mainWindow = new BaseWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    titleBarOverlay: false,
  })

  // Chrome view (tab bar + address bar) — always visible at top
  chromeView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/chrome.js'),
      sandbox: true,
    },
  })
  mainWindow.contentView.addChildView(chromeView)

  // Command Center view — toggled in/out of the content area
  commandCenterView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/command-center.js'),
      sandbox: true,
    },
  })
  // Don't add it yet — starts hidden

  // Tab manager owns user tab views
  tabManager = new TabManager(mainWindow, () => {
    const [width, height] = mainWindow.getContentSize()
    return { x: 0, y: CHROME_HEIGHT, width, height: height - CHROME_HEIGHT }
  })

  // Provide chromeView to tab manager for IPC forwarding
  tabManager.setChromeView(chromeView)

  // Register IPC handlers
  registerIPCHandlers(tabManager, commandCenterView)

  // Toggle command center IPC
  ipcMain.handle('view:toggle-command-center', () => {
    showingCommandCenter = !showingCommandCenter
    layoutViews()
    return showingCommandCenter
  })

  ipcMain.handle('view:is-command-center', () => {
    return showingCommandCenter
  })

  // Layout all views
  layoutViews()

  // Load renderer apps
  if (process.env.ELECTRON_RENDERER_URL) {
    chromeView.webContents.loadURL(`${process.env.ELECTRON_RENDERER_URL}/src/chrome/index.html`)
    commandCenterView.webContents.loadURL(`${process.env.ELECTRON_RENDERER_URL}/src/command-center/index.html`)
  } else {
    chromeView.webContents.loadFile(join(__dirname, '../renderer/src/chrome/index.html'))
    commandCenterView.webContents.loadFile(join(__dirname, '../renderer/src/command-center/index.html'))
  }

  // Open a default tab
  tabManager.openTab('about:blank')

  mainWindow.on('resize', layoutViews)
}

function layoutViews() {
  const [width, height] = mainWindow.getContentSize()
  const contentBounds = { x: 0, y: CHROME_HEIGHT, width, height: height - CHROME_HEIGHT }

  // Chrome bar always spans full width
  chromeView.setBounds({ x: 0, y: 0, width, height: CHROME_HEIGHT })

  if (showingCommandCenter) {
    // Hide active tab, show command center
    tabManager.hideActiveTab()
    mainWindow.contentView.addChildView(commandCenterView)
    commandCenterView.setBounds(contentBounds)
  } else {
    // Hide command center, show active tab
    mainWindow.contentView.removeChildView(commandCenterView)
    tabManager.layoutActiveTab()
  }
}

// Global safety net for unhandled rejections
process.on('unhandledRejection', (reason, _promise) => {
  console.error('[RLM] Unhandled rejection caught:', reason)
  if (commandCenterView && !commandCenterView.webContents.isDestroyed()) {
    commandCenterView.webContents.send('rlm:error', {
      error: `Unhandled async error: ${reason}`,
    })
  }
})

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (tabManager) tabManager.destroyAll()
  app.quit()
})
